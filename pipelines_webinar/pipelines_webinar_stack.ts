import path = require('path');
import {
  CfnOutput,
  Construct,
  Duration,
  Stack,
  StackProps,
} from '@aws-cdk/core';
import * as lambda from '@aws-cdk/aws-lambda';
import * as iam from '@aws-cdk/aws-iam';
import * as apigw from '@aws-cdk/aws-apigateway';
import * as codedeploy from '@aws-cdk/aws-codedeploy';
import * as cloudwatch from '@aws-cdk/aws-cloudwatch';
import * as synthetics from '@aws-cdk/aws-synthetics';
import * as ssm from '@aws-cdk/aws-ssm';

export class PipelinesWebinarStack extends Stack {
  urlOutput: CfnOutput;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const handler = new lambda.Function(this, 'Handler', {
      code: new lambda.AssetCode(path.resolve(__dirname, 'lambda')),
      handler: 'handler.handler',
      runtime: lambda.Runtime.NODEJS_10_X,
    });

    const alias = new lambda.Alias(this, 'x', {
      aliasName: 'Current',
      version: handler.currentVersion,
    });

    const api = new apigw.LambdaRestApi(this, 'Gateway', {
      description: 'Endpoint for a simple Lambda-powered web service',
      handler: alias,
    });

    const canary = new synthetics.Canary(this, 'RegressionTesting', {
      schedule: synthetics.Schedule.rate(Duration.minutes(1)),
      test: synthetics.Test.custom({
        code: synthetics.Code.fromAsset(path.join(__dirname, 'canary')),
        handler: 'apiCall.handler',
      }),

      runtime: synthetics.Runtime.SYNTHETICS_NODEJS_2_2,
      startAfterCreation: false
    });

    const cfnCanary = canary.node.defaultChild as synthetics.CfnCanary;
    cfnCanary.addPropertyOverride('RunConfig.EnvironmentVariables', {
      API_URL: api.url,
    });

    canary.node.addDependency(api);

    const failureAlarm = new cloudwatch.Alarm(this, 'CanaryAlarm', {
      metric: canary.metricSuccessPercent({
        period: Duration.minutes(1),
        statistic: cloudwatch.Statistic.AVERAGE,
      }),
      evaluationPeriods: 1,
      threshold: 90,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    });

    // TODO: Add stage to function name to avoid collision with stages
    const preHookLambda = new lambda.Function(this, 'startCanary', {
      functionName: `CodeDeployHook_Pre-${this.stackName}`,
      runtime: lambda.Runtime.NODEJS_10_X,
      handler: 'canaryController.startCanary',
      code: lambda.Code.fromAsset(path.join(__dirname, 'canary')),
      environment: {
        CANARY_NAME: canary.canaryName,
      },
    });

    const postHookLambda = new lambda.Function(this, 'stopCanary', {
      functionName: `CodeDeployHook_Post-${this.stackName}`,
      runtime: lambda.Runtime.NODEJS_10_X,
      handler: 'canaryController.stopCanary',
      code: lambda.Code.fromAsset(path.join(__dirname, 'canary')),
      environment: {
        CANARY_NAME: canary.canaryName,
      },
    });

    preHookLambda.addToRolePolicy(
      new iam.PolicyStatement({
        resources: ['*'],
        actions: ['synthetics:StartCanary', 'synthetics:StopCanary'],
      })
    );

    postHookLambda.addToRolePolicy(
      new iam.PolicyStatement({
        resources: ['*'],
        actions: ['synthetics:StartCanary', 'synthetics:StopCanary'],
      })
    );

    const lambdaDeploymentConfig = new codedeploy.CustomLambdaDeploymentConfig(
      this,
      'CustomConfig',
      {
        type: codedeploy.CustomLambdaDeploymentConfigType.CANARY,
        interval: Duration.minutes(5),
        percentage: 99,
      }
    );

    new codedeploy.LambdaDeploymentGroup(this, 'DeploymentGroup', {
      alias,
      deploymentConfig: lambdaDeploymentConfig,
      alarms: [failureAlarm],
      preHook: preHookLambda,
      postHook: postHookLambda,
    });

    this.urlOutput = new CfnOutput(this, 'url', { value: api.url });
  }
}
