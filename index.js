/*
 Copyright (c) 2019 Schematic Energy, LLC
 Released under the terms of the Apache 2.0 License
*/

"use strict";
const path = require("path");
const pulumi = require("@pulumi/pulumi");
const random = require("@pulumi/random");
const aws = require("@pulumi/aws");
const awsx = require("@pulumi/awsx");
const { initialize, PulumiContext } = require("@schematic-energy/pulumi-utils/context");
const script = require("@schematic-energy/pulumi-utils/script");
const git = require("@schematic-energy/pulumi-utils/git");
const iam = require("@schematic-energy/pulumi-utils/iam");
const coordinator = require("./coordinator.js");
const workers = require("./workers.js");

let ctx = initialize();

if (!/^[a-zA-Z0-9]+$/.test(ctx.env)) {
    throw new Error("Stack name is used as the environment name and may contain only alphanumeric characters");
};

let nameSuffix = `${ctx.env}.${ctx.cfg.require('publicDomainName')}`;
let buckets = {
    downloads: ctx.r(aws.s3.Bucket, "downloads", {
        bucket: `downloads.${nameSuffix}`,
        forceDestroy: true
    }),
    staging: ctx.r(aws.s3.Bucket, "staging", {
        bucket: `staging.${nameSuffix}`,
        forceDestroy: true
    }),
    archive: ctx.r(aws.s3.Bucket, "archive", {
        bucket: `archive.${nameSuffix}`,
        forceDestroy: !ctx.cfg.get("protect"),
        protect: ctx.cfg.get("protect")
    }),
    data: ctx.r(aws.s3.Bucket, "data", {
        bucket: `data.${nameSuffix}`,
        forceDestroy: !ctx.cfg.get("protect"),
        protect: ctx.cfg.get("protect")
    }),
    live: ctx.r(aws.s3.Bucket, "live", {
        bucket: `live.${nameSuffix}`,
        forceDestroy: !ctx.cfg.get("protect"),
        protect: ctx.cfg.get("protect")
    }),
    config: ctx.r(aws.s3.Bucket, "config", {
        bucket: `config.${nameSuffix}`,
        forceDestroy: true
    })
};

let securityGroup = ctx.r(aws.ec2.SecurityGroup, "scio-sg", {
    vpcId: ctx.cfg.require('vpcId'),
    tags: {Name: `Scio (${ctx.env})`},
    ingress: [{
        cidrBlocks: ctx.cfg.requireObject('allowedCidrs'),
        fromPort: 0,
        toPort: 0,
        protocol: "-1"
    }],
    egress: [{
        cidrBlocks: ["0.0.0.0/0"],
        fromPort: 0,
        toPort: 0,
        protocol: "-1"
    }]
}, { deleteBeforeReplace: true } );

let bucketAccessStatements = Object.values(buckets).map(b => {
    return iam.policyStmt([b.arn,
                           pulumi.interpolate `${b.arn}/*`],
                          ["s3:List*",
                           "s3:Get*",
                           "s3:Head*",
                           "s3:AbortMultipartUpload*",
                           "s3:Put*"]);
});

let ssmAccessStatements = [
    iam.policyStmt(pulumi.interpolate `arn:aws:ssm:${ctx.region}:${ctx.account}:parameter/scio/${ctx.env}/*`,
                   ["ssm:Get*", "ssm:Describe*"])
];

let instancePolicy = iam.policy(ctx, "scio-instance",
                                "Accesses required by Scio cluster instances",
                                bucketAccessStatements.concat(ssmAccessStatements));

let instanceProfile = iam.instanceProfile(ctx, "scio", ["ec2"], [instancePolicy.arn]);


let coordinatorFqdn = coordinator.instance(ctx, { securityGroup: securityGroup,
                                                  instanceProfile: instanceProfile,
                                                  configBucket: buckets.config.bucket });
let workerAutoScalingGroups = workers.autoScalingGroups(ctx, { securityGroup: securityGroup,
                                                               instanceProfile: instanceProfile,
                                                               configBucket: buckets.config.bucket,
                                                               coordinatorFqdn: coordinatorFqdn });

exports.scio = {
    instanceRole: instanceProfile.role,
    coordinator: { host: coordinatorFqdn,
                   securityGroup: securityGroup.id },
    workerGroups: workerAutoScalingGroups.map(asg => asg.name),
    buckets: Object.keys(buckets).reduce( (out, k) => {
        out[k] = buckets[k].bucket;
        return out;
    }, {} )
};

exports.storage = exports.scio;

//end
