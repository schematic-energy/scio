/*
 Copyright (c) 2019 Schematic Energy, LLC
 Released under the terms of the Apache 2.0 License
*/

"use strict";
const pulumi = require("@pulumi/pulumi");
const random = require("@pulumi/random");
const aws = require("@pulumi/aws");
const iam = require("pulumi-utils/iam");
const { PulumiContext } = require("pulumi-utils/context");

function configFiles (ctx, coordinatorFqdn, configBucket) {
    ctx = ctx.withGroup("config");

    let files = [];

    files.push(ctx.r(aws.s3.BucketObject, "node", {
        bucket: configBucket,
        key: "presto/worker/node.properties",
        content: pulumi.interpolate `
node.environment=${ctx.env}
node.id=$PRESTO_NODE_ID
node.data-dir=/home/ec2-user/presto
`
    }));

    files.push(ctx.r(aws.s3.BucketObject, "jvm", {
        bucket: configBucket,
        key: "presto/worker/jvm.config",
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
        key: "presto/worker/config.properties",
        content: pulumi.interpolate `
coordinator=false
http-server.http.port=8080
discovery.uri=http://${coordinatorFqdn}:8080
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
        key: "presto/worker/catalog/hive.properties",
        content: pulumi.interpolate `
connector.name=hive-hadoop2
hive.metastore.uri=thrift://${coordinatorFqdn}:9083
hive.non-managed-table-writes-enabled=true
hive.s3.staging-directory=/data/s3staging
hive.s3.skip-glacier-objects=true
hive.recursive-directories=true
hive.allow-drop-table=true
`
    }));

    return files;
};

exports.autoScalingGroups = function(ctx, {securityGroup, instanceProfile, configBucket, coordinatorFqdn}) {

    ctx = ctx.withGroup("workers");

    let ami = pulumi.output(aws.getAmi({
        executableUsers: ["self"],
        owners: ["407553720128"],
        filters: [{
            name: "name",
            values: [ctx.cfg.require("prestoWorkerAmi")]
        }]
    })).id;

    let userData = pulumi.interpolate `
#!/bin/bash

sudo su ec2-user /home/ec2-user/run.sh ${ctx.env} s3://${configBucket}/presto/worker
`;

    let spotWorkerLaunchConfig = ctx.r(aws.ec2.LaunchConfiguration, "worker-config", {
        iamInstanceProfile: instanceProfile,
        imageId: ami,
        instanceType: ctx.cfg.require("prestoWorkerType"),
        keyName: ctx.cfg.require('keypair'),
        securityGroups: [securityGroup.id],
        spotPrice: ctx.cfg.require("prestoWorkerBidPrice"),
        userData: userData
    });

    let dedicatedWorkerLaunchConfig = ctx.r(aws.ec2.LaunchConfiguration, "dedicated-worker-config", {
        iamInstanceProfile: instanceProfile,
        imageId: ami,
        instanceType: ctx.cfg.require("prestoWorkerType"),
        keyName: ctx.cfg.require('keypair'),
        securityGroups: [securityGroup.id],
        userData: userData
    });

    let tagMaps = Object.keys(ctx.props.tags).map(k => {
        return { key: k,
                 value: ctx.props.tags[k],
                 propagateAtLaunch: true };
    });
    let asgCtx = new PulumiContext({tags: tagMaps}, ctx.opts);

    let cfgs = configFiles(ctx, coordinatorFqdn, configBucket);

    let groups = [];

    if (ctx.cfg.require("prestoSpotWorkers") > 0) {
        groups.push(asgCtx.r(aws.autoscaling.Group, "workers", {
            launchConfiguration: spotWorkerLaunchConfig.name,
            name: `scio-workers-${ctx.env}`,
            minSize: 1,
            maxSize: 10,
            desiredCapacity: ctx.cfg.require("prestoSpotWorkers"),
            forceDelete: true,
            healthCheckGracePeriod: 120,
            vpcZoneIdentifiers: ctx.cfg.requireObject('subnets')
        }, { dependsOn: [cfgs] }));
    }

    if (ctx.cfg.require("prestoDedicatedWorkers") > 0) {
        groups.push(asgCtx.r(aws.autoscaling.Group, "dedicatedWorkers", {
            name: `scio-dedicatedWorkers-${ctx.env}`,
            launchConfiguration: dedicatedWorkerLaunchConfig.name,
            minSize: 1,
            maxSize: 10,
            desiredCapacity: ctx.cfg.require("prestoDedicatedWorkers"),
            forceDelete: true,
            healthCheckGracePeriod: 120,
            vpcZoneIdentifiers: ctx.cfg.requireObject('subnets')
        }, { dependsOn: [cfgs] }));
    }

    return groups;
};
