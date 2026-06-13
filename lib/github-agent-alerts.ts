import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { GitHubWorkflow } from '@github-actions-cdk/aws-cdk';
import * as fs from 'fs';
import * as path from 'path';

export interface GitHubAgentAlertsProps {
  readonly githubOwner: string;
  readonly githubRepo: string;
  readonly githubTokenSecretName?: string;
  readonly copilotRoleName?: string;
  readonly allowedRefs?: string[];
  readonly alarmMetric?: cloudwatch.IMetric;
  readonly outputDir?: string;
}

export class GitHubAgentAlertsConstruct extends Construct {
  public readonly oidcProvider: iam.OpenIdConnectProvider;
  public readonly agentRole: iam.Role;
  public readonly alarmTopic: sns.Topic;
  public readonly exampleAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: GitHubAgentAlertsProps) {
    super(scope, id);

    const tokenName = props.githubTokenSecretName || '/github/pat';

    // 1. GitHub OIDC Provider
    this.oidcProvider = new iam.OpenIdConnectProvider(this, 'GitHubOidc', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    // 2. IAM Role for Agent / Workflows
    const subConditions = (props.allowedRefs || ['*']).map(ref =>
      `repo:${props.githubOwner}/${props.githubRepo}:${ref}`
    );

    this.agentRole = new iam.Role(this, 'AgentRole', {
      roleName: props.copilotRoleName || `${props.githubRepo}-gh-agent-role`,
      assumedBy: new iam.WebIdentityPrincipal(this.oidcProvider.openIdConnectProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: { 'token.actions.githubusercontent.com:sub': subConditions },
      }),
    });

    this.agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:*', 'lambda:InvokeFunction', 'ssm:GetParameter'],
      resources: ['*'],
    }));

    // 3. Alarm → SNS → Lambda (GitHub Issue)
    this.alarmTopic = new sns.Topic(this, 'AlertTopic');

    const issueLambda = new lambda.Function(this, 'CreateIssueLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const { Octokit } = require('@octokit/rest');
        exports.handler = async (event) => {
          const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
          const msg = JSON.parse(event.Records[0].Sns.Message);
          await octokit.issues.create({
            owner: '${props.githubOwner}',
            repo: '${props.githubRepo}',
            title: \`🚨 CloudWatch: \${msg.AlarmName}\`,
            body: \`**State:** \${msg.NewStateValue}\n**Reason:** \${msg.NewStateReason}\`,
            labels: ['alert', 'cloudwatch'],
          });
        };
      `),
      environment: { GITHUB_TOKEN: ssm.StringParameter.valueForSecureStringParameter(this, tokenName) },
    });

    this.alarmTopic.addSubscription(new subscriptions.LambdaSubscription(issueLambda));

    // Example Alarm
    this.exampleAlarm = new cloudwatch.Alarm(this, 'HighErrorAlarm', {
      metric: props.alarmMetric || new cloudwatch.Metric({
        namespace: 'AWS/Lambda', metricName: 'Errors', statistic: 'Sum', period: cdk.Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 2,
    });
    this.exampleAlarm.addAlarmAction(new actions.SnsAction(this.alarmTopic));

    // 4. GitHubWorkflow from @github-actions-cdk/aws-cdk
    new GitHubWorkflow(this, 'CdkDeployWorkflow', {
      owner: props.githubOwner,
      repo: props.githubRepo,
      workflowName: 'cdk-deploy',
      jobs: {
        synth: {
          runsOn: 'ubuntu-latest',
          steps: [
            { uses: 'actions/checkout@v4' },
            { uses: 'actions/setup-node@v4', with: { nodeVersion: '20' } },
            { run: 'npm ci' },
            { run: 'npx cdk synth' },
          ],
        },
      },
    } as any);

    // 5. Generate gh-aw Agentic Workflow
    this.generateAgenticWorkflow(props);

    // Outputs
    new cdk.CfnOutput(this, 'AgentRoleArn', { value: this.agentRole.roleArn });
    new cdk.CfnOutput(this, 'OidcProviderArn', { value: this.oidcProvider.openIdConnectProviderArn });
  }

  private generateAgenticWorkflow(props: GitHubAgentAlertsProps) {
    const awDir = path.join(props.outputDir || process.cwd(), '.github', 'aw');
    fs.mkdirSync(awDir, { recursive: true });

    const content = `---
on:
  issues:
    types: [opened]
permissions:
  issues: write
  contents: read
  pull-requests: read
safe-outputs:
  add-labels: true
  add-comment: true
engine: copilot
---

You are an autonomous GitHub Agent. On new issue:
- Triage and label it.
- Use AWS OIDC role (\`{{ secrets.AWS_ROLE_ARN }}\`) if needed for CloudWatch context.
- Comment with analysis and next steps.
`;

    fs.writeFileSync(path.join(awDir, 'issue-triage.md'), content);
    console.log('✅ Generated .github/aw/issue-triage.md');
  }
}
