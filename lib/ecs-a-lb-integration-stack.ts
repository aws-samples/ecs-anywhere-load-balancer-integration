import * as dotenv from "dotenv";
dotenv.config();
dotenv.config({ path: `.env.local`, override: true });

import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { SqsDestination } from "aws-cdk-lib/aws-lambda-destinations";
import * as sqs from "aws-cdk-lib/aws-sqs";

import * as path from "path";

export class EcsALbIntegrationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const name = "ecs-a-lb-integration";
    const deployService = !!process.env.DEPLOY_SERVICE;
    const slackWebHookUrl = process.env.SLACK_WEBHOOK_URL || "";

    // VPC
    const vpc1 = new ec2.Vpc(this, "Vpc1", {
      vpcName: `${name}-1`,
      ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/16"),
      natGateways: 1,
    });
    const vpc2 = new ec2.Vpc(this, "Vpc2", {
      vpcName: `${name}-2`,
      ipAddresses: ec2.IpAddresses.cidr("100.64.0.0/16"),
      natGateways: 1,
    });
    const vpcPeering = new ec2.CfnVPCPeeringConnection(this, "VpcPeering", {
      vpcId: vpc1.vpcId,
      peerVpcId: vpc2.vpcId,
    });
    vpc1.publicSubnets.forEach(({ routeTable: { routeTableId } }, index) => {
      new ec2.CfnRoute(this, `Vpc1Peering${index + 1}`, {
        destinationCidrBlock: vpc2.vpcCidrBlock,
        routeTableId,
        vpcPeeringConnectionId: vpcPeering.ref,
      });
    });
    vpc2.privateSubnets.forEach(({ routeTable: { routeTableId } }, index) => {
      new ec2.CfnRoute(this, `Vpc2Peering${index + 1}`, {
        destinationCidrBlock: vpc1.vpcCidrBlock,
        routeTableId,
        vpcPeeringConnectionId: vpcPeering.ref,
      });
    });
    const eicEndpointSg = new ec2.SecurityGroup(this, "EicEndpointSg", {
      securityGroupName: `${name}-eic`,
      vpc: vpc2,
      allowAllOutbound: true,
    });
    new cdk.CfnOutput(this, "EicEndpoint", {
      value: `aws ec2 create-instance-connect-endpoint --subnet-id ${vpc2.privateSubnets[0].subnetId} --security-group-id ${eicEndpointSg.securityGroupId}`,
    });

    // ALB
    const albSg = new ec2.SecurityGroup(this, "AlbSg", {
      securityGroupName: `${name}-alb`,
      vpc: vpc1,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));
    const alb = new elbv2.ApplicationLoadBalancer(this, "Alb", {
      loadBalancerName: name,
      vpc: vpc1,
      internetFacing: true,
      securityGroup: albSg,
    });
    const targetGroup = new elbv2.ApplicationTargetGroup(this, "TargetGroup", {
      targetGroupName: name,
      targetType: elbv2.TargetType.IP,
      protocol: elbv2.ApplicationProtocol.HTTP,
      vpc: vpc1,
    });
    new cdk.CfnOutput(this, "TargetGroupArn", {
      value: targetGroup.targetGroupArn,
    });
    alb.addListener("Listener", {
      port: 80,
      open: true,
      defaultTargetGroups: [targetGroup],
    });
    new cdk.CfnOutput(this, "AlbDnsName", {
      value: alb.loadBalancerDnsName,
    });

    // ECS
    const cluster = new ecs.Cluster(this, "Cluster", {
      clusterName: name,
      vpc: vpc1,
    });

    // ECS-A Instance
    const instanceSg = new ec2.SecurityGroup(this, "InstanceSg", {
      securityGroupName: `${name}-instance`,
      vpc: vpc2,
      allowAllOutbound: true,
    });
    instanceSg.addIngressRule(albSg, ec2.Port.allTraffic());
    instanceSg.addIngressRule(eicEndpointSg, ec2.Port.allTraffic());
    instanceSg.addIngressRule(
      ec2.Peer.ipv4(vpc1.vpcCidrBlock),
      ec2.Port.allTraffic()
    );
    instanceSg.addIngressRule(
      ec2.Peer.ipv4(vpc2.vpcCidrBlock),
      ec2.Port.allTraffic()
    );
    const machineImage = ec2.MachineImage.fromSsmParameter(
      "/aws/service/canonical/ubuntu/server/focal/stable/current/amd64/hvm/ebs-gp2/ami-id"
    );
    const instance = new ec2.Instance(this, "Instance", {
      instanceName: name,
      vpc: vpc2,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3A,
        ec2.InstanceSize.SMALL
      ),
      machineImage,
      securityGroup: instanceSg,
    });
    instance.node.tryRemoveChild("InstanceProfile");
    const instanceResource = instance.node.findChild(
      "Resource"
    ) as ec2.CfnInstance;
    instanceResource.addDeletionOverride("Properties.IamInstanceProfile");
    new cdk.CfnOutput(this, "Eic", {
      value: `aws ec2-instance-connect ssh --instance-id ${instance.instanceId} --os-user ubuntu`,
    });
    const ecsAnywhereRole = new iam.Role(this, "EcsAnywhereRole", {
      roleName: `${name}-ssm`,
      assumedBy: new iam.ServicePrincipal("ssm.amazonaws.com"),
    });
    ecsAnywhereRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")
    );
    ecsAnywhereRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "service-role/AmazonEC2ContainerServiceforEC2Role"
      )
    );
    new cdk.CfnOutput(this, "Ssm", {
      value: `aws ssm create-activation --iam-role ${ecsAnywhereRole.roleName}`,
    });

    // ECS Service
    let serviceName = "";
    if (deployService) {
      const taskDefinition = new ecs.ExternalTaskDefinition(this, "TaskDef", {
        networkMode: ecs.NetworkMode.BRIDGE,
      });
      taskDefinition.addContainer("DefaultContainer", {
        image: ecs.ContainerImage.fromRegistry("amazon/amazon-ecs-sample"),
        memoryLimitMiB: 512,
        portMappings: [{ containerPort: 80 }],
      });
      const service = new ecs.ExternalService(this, "Service", {
        serviceName: "external-service",
        cluster,
        taskDefinition,
        desiredCount: 3,
      });
      serviceName = service.serviceName;
    }

    const dlq = new sqs.Queue(this, "Dlq", { queueName: `${name}-dlq` });

    // SQS -> Lambda -> Slack for notification
    const notificationQueue = new sqs.Queue(this, "NotificationQueue", {
      queueName: `${name}`,
      deadLetterQueue: { queue: dlq, maxReceiveCount: 1 },
    });
    const notificationFn = new lambda.Function(this, "NotificationFunction", {
      functionName: `${name}-notification`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "notification")),
      environment: { SLACK_WEBHOOK_URL: slackWebHookUrl },
    });
    notificationFn.addEventSource(
      new SqsEventSource(notificationQueue, { batchSize: 1 })
    );

    // EventBridge -> Lambda for IP handler
    const fnRole = new iam.Role(this, "FunctionRole", {
      roleName: `${name}-fn`,
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    });
    fnRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonECS_FullAccess")
    );
    fnRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMFullAccess")
    );
    fnRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        "ElasticLoadBalancingFullAccess"
      )
    );
    const destination = new SqsDestination(notificationQueue);
    const fn = new lambda.Function(this, "Function", {
      functionName: name,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "ip-handler")),
      role: fnRole,
      environment: { TARGET_GROUP_ARN: targetGroup.targetGroupArn },
      onSuccess: destination,
      onFailure: destination,
    });
    const rule = new events.Rule(this, "Rule", {
      ruleName: name,
      eventPattern: {
        source: ["aws.ecs"],
        detailType: ["ECS Task State Change"],
        detail: {
          clusterArn: [cluster.clusterArn],
          group: [`service:${serviceName}`],
          $or: [
            { desiredStatus: ["STOPPED"], lastStatus: ["STOPPED"] },
            { desiredStatus: ["RUNNING"], lastStatus: ["RUNNING"] },
          ],
        },
      },
    });
    rule.addTarget(new targets.LambdaFunction(fn, { deadLetterQueue: dlq }));

    const dashboard = new cloudwatch.Dashboard(this, "Dashboard", {
      dashboardName: name,
    });
    if (deployService) {
      dashboard.addWidgets(
        createWidget("Success Registering", name, serviceName),
        createWidget("Fail Registering", name, serviceName),
        createWidget("Success Deregistering", name, serviceName),
        createWidget("Fail Deregistering", name, serviceName)
      );
    }
  }
}

const createWidget = (title: string, cluster: string, service: string) =>
  new cloudwatch.SingleValueWidget({
    title: title,
    metrics: [
      new cloudwatch.Metric({
        namespace: "ECS-A",
        metricName: title.replace(" ", ""),
        dimensionsMap: { Cluster: cluster, Service: service },
        statistic: cloudwatch.Stats.SUM,
        label: "Total Count (7 Days)",
        period: cdk.Duration.days(7),
      }),
    ],
  });
