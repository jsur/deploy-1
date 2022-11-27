import * as cdk from "aws-cdk-lib";
import { Repository } from "aws-cdk-lib/aws-ecr";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import { Construct } from "constructs";
import {
  CodeBuildAction,
  EcsDeployAction,
  GitHubSourceAction,
  GitHubTrigger,
} from "aws-cdk-lib/aws-codepipeline-actions";
import { Artifact } from "aws-cdk-lib/aws-codepipeline";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { CfnRepository } from "aws-cdk-lib/aws-codeartifact";
import { LinuxBuildImage, Source } from "aws-cdk-lib/aws-codebuild";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Cluster, EcrImage } from "aws-cdk-lib/aws-ecs";
import { Vpc } from "aws-cdk-lib/aws-ec2";
import { ApplicationLoadBalancedFargateService } from "aws-cdk-lib/aws-ecs-patterns";

export class DeployStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const domain = new cdk.aws_codeartifact.CfnDomain(
      this,
      `${this.stackName}-codeartifact-domain`,
      {
        domainName: "deploy-1",
      }
    );

    const upstream = new CfnRepository(
      this,
      `${this.stackName}-codeartifact-upstream-repo`,
      {
        domainName: domain.domainName,
        repositoryName: "npm-store",
        externalConnections: ["npmjs"],
      }
    );
    upstream.node.addDependency(domain);

    const caRepo = new CfnRepository(
      this,
      `${this.stackName}-codeartifact-repo`,
      {
        domainName: domain.domainName,
        repositoryName: "npm",
        upstreams: [upstream.repositoryName],
      }
    );
    [domain, upstream].forEach((item) => caRepo.node.addDependency(item));

    const ecrRepo = new Repository(this, `${this.stackName}-ecr-repo`, {
      repositoryName: "deploy-1",
    });

    const pipeline = new codepipeline.Pipeline(
      this,
      `${this.stackName}-codepipeline`,
      {
        pipelineName: "deploy-1-dev",
      }
    );

    const ghArtifact = new Artifact();

    const secret = Secret.fromSecretCompleteArn(
      this,
      "gh-secret",
      "arn:aws:secretsmanager:eu-central-1:566312720731:secret:dev-deploy-1-38mH2V"
    );

    secret.grantRead(pipeline.role);

    pipeline.addStage({
      stageName: "Source",
      actions: [
        new GitHubSourceAction({
          actionName: "gh-source-action",
          output: ghArtifact,
          owner: "jsur",
          repo: "deploy-1",
          branch: "master",
          oauthToken: secret.secretValueFromJson("GH_OAUTH_TOKEN"),
          trigger: GitHubTrigger.WEBHOOK,
        }),
      ],
    });

    const cbProject = new cdk.aws_codebuild.Project(this, "build", {
      environment: {
        buildImage: LinuxBuildImage.STANDARD_6_0,
        privileged: true,
      },
      source: Source.gitHub({
        owner: "jsur",
        repo: "deploy-1",
      }),
    });

    cbProject.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "ecr:BatchCheckLayerAvailability",
          "ecr:CompleteLayerUpload",
          "ecr:GetAuthorizationToken",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
          "codeartifact:GetAuthorizationToken",
          "codeartifact:GetRepositoryEndpoint",
          "codeartifact:ReadFromRepository",
        ],
        resources: ["*"],
      })
    );

    cbProject.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["sts:GetServiceBearerToken"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "sts:AWSServiceName": "codeartifact.amazonaws.com",
          },
        },
      })
    );

    const imageDefinitions = new Artifact();
    pipeline.addStage({
      stageName: "Build",
      actions: [
        new CodeBuildAction({
          actionName: "codebuild-action",
          input: ghArtifact,
          outputs: [imageDefinitions],
          project: cbProject,
        }),
      ],
    });

    const vpc = new Vpc(this, "vpc-1");

    const fargateService = new ApplicationLoadBalancedFargateService(
      this,
      `${this.stackName}-fg-svc`,
      {
        cluster: new Cluster(this, "deploy-1-cluster", { vpc }),
        listenerPort: 80,
        cpu: 256,
        memoryLimitMiB: 512,
        desiredCount: 1,
        taskImageOptions: {
          image: EcrImage.fromEcrRepository(ecrRepo, "latest"),
          containerPort: 5005,
          enableLogging: true,
          containerName: "deploy-1",
        },
      }
    );

    pipeline.addStage({
      stageName: "Deploy",
      actions: [
        new EcsDeployAction({
          actionName: "ecs-deploy",
          input: imageDefinitions,
          service: fargateService.service,
        }),
      ],
    });
  }
}
