# Scio

Scio is Schematic Energy's set of tools and patterns designed to make
it easy to set up a Presto data warehouse on AWS.

This repository contains a [Pulumi](www.pulumi.com) project that
installs a fully configured Presto instance with Hive metastore
and S3 buckets for data storage.

## Prerequisites

- An AWS account with administrative privileges.
- The ability to create Pulumi stacks (we reccomend following Pulumi's
  [S3 Website](https://www.pulumi.com/docs/tutorials/aws/s3-website/)
  tutorial first, to understand how Pulumi works and select a suitable
  [backend](https://www.pulumi.com/docs/intro/concepts/state/) that meets your needs.)
- An AWS VPC with two or more subnets in different availability zones.
- A Route53 Hosted Zone for cluster DNS (can be internal, if linked to the VPC)
- An AWS Keypair

## First-time Installation and Configuration

1. Clone the
   [presto-ami](https://github.com/schematic-energy/presto-ami)
   repository, and follow its instructions to build and install AMIs
   in your AWS account. Take note of the names of the AMIs it creates,
   both the coordinator and the worker.
2. Clone this repository.
3. In this directory, create a new Pulumi stack. The name of the stack is your *environment name*.
4. Edit `Pulumi.<env>.yaml` Enter the following values:

```yaml
config:
  aws:allowedAccountIds: '["1234567890"]'     # Your AWS Account ID
  aws:region: us-east-1                       # The region you want to use
  scio:organization: "example"                # The organization name, used to name various artifacts
  scio:vpcId: "vpc-1234569abcde"              # The VPC ID you want to use
  scio:publicDomainName: "example.com"        # The domain name suffix associated with this installation.
                                              # Used to ensure unique S3 bucket names
  scio:route53ZoneId: "Z1234567"              # The ID of the hosted zone you'll use for DNS resolution
  scio:coordinatorDnsPrefix: "scio.staging"   # The DNS prefix used to register the coordinator in the hosted zone
  scio:subnets: '["subnet-abc", "subnet-xyz]' # Subnets to deploy into
  scio:allowedCidrs: '["0.0.0.0/0"]'          # Network access whitelist (including Scio deployment itself)
  scio:keypair: "my-keypair"                  # Name of the keypair
  scio:prestoAmiOwner: "407553720128"         # Your AWS account ID
  # The coordinator AMI name from Step 1
  scio:prestoCoordinatorAmi: schematic/presto-coordinator-v24-79562d0
  # The worker AMI name from Step 1
  scio:prestoWorkerAmi: schematic/presto-worker-v24-79562d0
  scio:prestoCoordinatorType: m5.large        # Instance type for the coordinator. m5.large is reccomended
  scio:prestoDedicatedWorkers: 0              # Number of EC2 on-demand instances to use as workers
  scio:prestoSpotWorkers: 5                   # Number of EC2 spot instances to request as workers
  scio:prestoWorkerBidPrice: "0.25"           # Bid price for spot requests
  scio:prestoWorkerType: r4.4xlarge           # Worker instance type
  scio:protect: true                          # Set to true to prevent accidental removal of data buckets
  # Override values appended to Presto's config.properties file
  scio:prestoConfig: |
    experimental.max-spill-per-node=130GB
    query.max-memory=128GB

```

Then, run `pulumi up`. After a few minutes, the system should be running.

## Adding Schemas

By default, the Presto instance is configured with as single Hive
connector named `hive`. Hive is only installed on the coordinator
node, not any of the workers. Therefore, Hive should only be used when
it is necessary to create a table using Hive DDL. Queries should
always be written in Presto to leverage the full Presto cluster.

To transact Hive DDL, connect to the Hive server running on the
coordinator on port 10000.

You can also use the complementary
[scio-schema](https://github.com/schematic-energy/scio-schema) project
to manage schema installation, if you wish.

## Adding Catalogs

To add additional catalogs to Presto, add the corresponding
`*.properties` files to the `config.<env>.<publicDomainName>` S3
bucket, at the `/presto/coordinator/catalog/<name>.properties` and
`/presto/worker/catalog/<name>.properties`.

New nodes will automatically download this configuration and start
with the catalog enabled.

To enable the catalog on running nodes, it is necessary to restart
them. An HTTP endpoint has been added for this purpose: on each node,
a HTTP request to `http://<host>/cgi-bin/update-config.sh` will cause
the new configuration to be downloaded and the node restarted.

If you are using Pulumi to add connectors, you can require the `scio`
project as a Node library and invoke the `config/catalog` function to
add a catalog and automatically restart all running nodes.
