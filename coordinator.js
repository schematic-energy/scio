/*
 Copyright (c) 2019 Schematic Energy, LLC
 Released under the terms of the Apache 2.0 License
*/

"use strict";
const pulumi = require("@pulumi/pulumi");
const random = require("@pulumi/random");
const aws = require("@pulumi/aws");
const iam = require("@schematic-energy/pulumi-utils/iam");
const { PulumiContext } = require("@schematic-energy/pulumi-utils/context");

function configFiles (ctx, configBucket) {
    ctx = ctx.withGroup("config");

    let files = [];

    files.push(ctx.r(aws.s3.BucketObject, "node", {
        bucket: configBucket,
        key: "presto/coordinator/node.properties",
        content: pulumi.interpolate `
node.environment=${ctx.env}
node.id=$PRESTO_NODE_ID
node.data-dir=/home/ec2-user/presto
`
    }));

    files.push(ctx.r(aws.s3.BucketObject, "jvm", {
        bucket: configBucket,
        key: "presto/coordinator/jvm.config",
        content: `
-server
-Xms$JVM_XMS
-Xmx$JVM_XMX
-XX:-UseBiasedLocking
-XX:+UseG1GC
-XX:G1HeapRegionSize=32M
-XX:+ExplicitGCInvokesConcurrent
-XX:+ExitOnOutOfMemoryError
-XX:+UseGCOverheadLimit
-XX:+HeapDumpOnOutOfMemoryError
-XX:ReservedCodeCacheSize=512M
-Djdk.attach.allowAttachSelf=true
-Djdk.nio.maxCachedBufferSize=2000000
`
    }));

    files.push(ctx.r(aws.s3.BucketObject, "config", {
        bucket: configBucket,
        key: "presto/coordinator/config.properties",
        content: pulumi.interpolate `
coordinator=true
node-scheduler.include-coordinator=false
http-server.http.port=8080
discovery-server.enabled=true
discovery.uri=http://localhost:8080
join-distribution-type=AUTOMATIC
optimizer.join-reordering-strategy=AUTOMATIC
experimental.spill-enabled=true
experimental.spill-order-by=true
experimental.spill-window-operator=true
experimental.spiller-spill-path=/data/spill
${ctx.cfg.get('prestoConfig')}
`
    }));

    files.push(ctx.r(aws.s3.BucketObject, "hive", {
        bucket: configBucket,
        key: "presto/coordinator/catalog/hive.properties",
        content: pulumi.interpolate `
connector.name=hive-hadoop2
hive.metastore.uri=thrift://localhost:9083
hive.non-managed-table-writes-enabled=true
hive.s3.staging-directory=/data/s3staging
hive.s3.skip-glacier-objects=true
hive.recursive-directories=true
hive.allow-drop-table=true
`
    }));

    return files;
};


function hiveMetastore(ctx, securityGroup) {
    ctx = ctx.withGroup("hive-metastore");

    let password = ctx.r(random.RandomString, "hive-metastore-password", {
        length: 32,
        special: false,
        additionalSecretOutputs: ["result"]
    }).result;

    let snapshotId = ctx.r(random.RandomString, "snapshot-id", {
        length: 10,
        special: false
    }).result;

    let hiveMetastoreSubnetGroup = ctx.r(aws.rds.SubnetGroup, "hive-metastore", {
        subnetIds: ctx.cfg.requireObject('subnets')
    });

    let instance = ctx.r(aws.rds.Instance, "hive-metastore", {
        engine: "postgres",
        port: 5432,
        instanceClass: "db.t2.micro",
        engineVersion: "11.4",
        allocatedStorage: 20,
        name: "hive",
        username: "hive",
        password: password,
        vpcSecurityGroupIds: [securityGroup.id],
        dbSubnetGroupName: hiveMetastoreSubnetGroup.name,
        deletionProtection: ctx.cfg.get("protect"),
        skipFinalSnapshot: !ctx.cfg.get("protect"),
        finalSnapshotIdentifier: pulumi.interpolate `hive-metastore-${ctx.env}-final-snapshot-${snapshotId}`,
        applyImmediately: true
    });

    ctx.r(aws.ssm.Parameter, "hive-metastore-password", {
        name: `/scio/${ctx.env}/hive-metastore/password`,
        description: "Postgresql password for Hive Metastore database",
        value: password,
        type: "SecureString"
    });

    ctx.r(aws.ssm.Parameter, "hive-metastore-host", {
        name: `/scio/${ctx.env}/hive-metastore/host`,
        description: "Postgresql host for Hive Metastore database",
        value: instance.address,
        type: "String"
    });

    return ctx.group;
}


exports.autoScalingGroup = function(ctx, {securityGroup, instanceProfile, configBucket}) {

    ctx = ctx.withGroup("coordinator");

    let metastoreGroup = hiveMetastore(ctx, securityGroup);

    let ami = pulumi.output(aws.getAmi({
        executableUsers: ["self"],
        owners: [ctx.cfg.require('prestoAmiOwner')],
        filters: [{
            name: "name",
            values: [ctx.cfg.require("prestoCoordinatorAmi")]
        }]
    })).id;

    let cfgs = configFiles(ctx, configBucket);

    let launchCfg = ctx.r(aws.ec2.LaunchConfiguration, "launch-config", {
        iamInstanceProfile: instanceProfile,
        imageId: ami,
        instanceType: ctx.cfg.require("prestoCoordinatorType"),
        keyName: ctx.cfg.require('keypair'),
        securityGroups: [securityGroup.id],
        spotPrice: ctx.cfg.require("prestoWorkerBidPrice"),
        userData:  pulumi.interpolate `#!/bin/bash
sudo su ec2-user /home/ec2-user/run.sh ${ctx.env} s3://${configBucket}/presto/coordinator
`
    },{ dependsOn: [metastoreGroup, cfgs]} );

    let tagMaps = Object.keys(ctx.props.tags).map(k => {
        return {
            key: k,
            value: ctx.props.tags[k],
            propagateAtLaunch: true
        };
    });
    let asgCtx = new PulumiContext({tags: tagMaps}, ctx.opts);

    let lb = ctx.r(aws.lb.LoadBalancer, `scio-coordinator-${ctx.env}`, {
        loadBalancerType: "application",
        internal: true,
        subnets: ctx.cfg.requireObject('subnets'),
        securityGroups: [securityGroup.id],
        vpcId: ctx.cfg.require('vpcId'),
        zoneId: ctx.cfg.require('route53ZoneId')
    });

    let tg = ctx.r(aws.lb.TargetGroup, `scio-coordinator-${ctx.env}`, {
        port: 8080,
        protocol: "HTTP",
        vpcId: ctx.cfg.require('vpcId'),
        targetType: "instance",
        deregistrationDelay: 10,
        healthCheck: {
            port: 80,
            enabled: true,
            interval: 30,
            timeout: 10,
            path: "/cgi-bin/healthcheck.sh",
            healthy_threshold: 2,
            unhealthy_threshold: 2,
            matcher: "200-299"
        }
    });

    ctx.r(aws.lb.Listener, `scio-8080-${ctx.env}`, {
        loadBalancerArn: lb.arn,
        port: 8080,
        protocol: "HTTP",
        defaultActions: [{
            type: "forward",
            targetGroupArn: tg.arn
        }]
    });

    let asg = asgCtx.r(aws.autoscaling.Group, "coordinator", {
        name: `scio-coordinator-${ctx.env}`,
        vpcZoneIdentifiers: ctx.cfg.requireObject('subnets'),
        targetGroupArns: [tg],
        launchConfiguration: launchCfg,
        minSize: 1,
        maxSize: 1,
        desiredCapacity: 1,
        healthCheckGracePeriod: 120,
        healthCheckType: "ELB"
    }, {dependsOn: cfgs});

    let coordinatorDns = ctx.r(aws.route53.Record, `scio-coordinator-${ctx.env}`, {
        zoneId: ctx.cfg.require('route53ZoneId'),
        type: "CNAME",
        ttl: 30,
        name: ctx.cfg.require('coordinatorDnsPrefix'),
        records: [lb.dnsName]
    });

    return {
        fqdn: coordinatorDns.fqdn,
        asg: asg
    }
};

//end
