/*
 Copyright (c) 2019 Schematic Energy, LLC
 Released under the terms of the Apache 2.0 License
*/

"use strict";
const pulumi = require("@pulumi/pulumi");
const aws = require("@pulumi/aws");
const script = require("@schematic-energy/pulumi-utils/script");
const iam = require("@schematic-energy/pulumi-utils/iam");

/**
   Add a catalog to Presto. Arguments:

   - `ctx` - The @schematic-energy/pulumi-utils context
   - `name` - The name of the connector. Must be unique to the Presto instance.
   - `scio` - The stack output from the Scio Pulumi stack.
   - `cfg` - the contents of the connector config file.
 */
exports.catalog = function(ctx, name, scio, cfg){

    ctx = ctx.withGroup(`connector-${name}`);

    let workerCfg = ctx.r(aws.s3.BucketObject, `worker-cfg`, {
        bucket: scio.buckets.config,
        key: pulumi.interpolate `presto/worker/catalog/${name}.properties`,
        content: cfg
    });

    let coordinatorCfg = ctx.r(aws.s3.BucketObject, `coordinator-cfg`, {
        bucket: scio.buckets.config,
        key: pulumi.interpolate `presto/coordinator/catalog/${name}.properties`,
        content: cfg
    });

    let token = pulumi.all([workerCfg.etag, coordinatorCfg.etag]).apply(v => "#" + v.join(""));

    let asgNames = pulumi.all([scio.coordinatorGroup.name, scio.workerGroups]).apply(v => {
        let names = [];
        names.push(v[0])
        Array.prototype.push.apply(names, v[1])
        return names.join(" ");
    });

    let getInstanceIds = ctx.r(script.AwsCommand, 'getInstanceIds', {
        region: ctx.region,
        timeout: 30,
        cmd: ["aws autoscaling describe-auto-scaling-groups",
              "--auto-scaling-group-names", pulumi.interpolate `${asgNames}`,
              "--query 'AutoScalingGroups[].Instances[].InstanceId'",
              "--output json", token]
    }, {dependsOn: [workerCfg, coordinatorCfg]});

    let getInstanceIps = ctx.r(script.AwsCommand, `getInstanceIps`, {
        region: ctx.region,
        timeout: 30,
        cmd: ["aws ec2 describe-instances",
              "--instance-ids", pulumi.interpolate `'${getInstanceIds.result}'`,
              "--query 'Reservations[].Instances[].PrivateIpAddress'",
              "--output json", token]
    });

    let restartScript = pulumi.all([getInstanceIds.result,
                                    getInstanceIps.result,
                                    token]).apply(([ids, ips, token]) => {
        let script = `${token}\n`;

        if(JSON.parse(ids).length == 0) {
            return script;
        }

        for(var ip of JSON.parse(ips)) {
            script += `\ncurl http://${ip}/cgi-bin/update-config.sh`;
        }

        script += "\nsleep 15";

        return script;
    });

    let restartNodes = ctx.r(script.ScriptResource, "restart-nodes", {
        script: restartScript
    });

    return restartNodes;
};
