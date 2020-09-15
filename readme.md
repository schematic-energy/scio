# Scio

Scio is Schematic Energy's set of tools and patterns designed to make
it easy to set up a Presto data warehouse on AWS.

This repository contains a [Pulumi](www.pulumi.com) project that
installs a fully configured Presto instance with Hive metastore
and S3 buckets for data storage.



## Prerequisites

You will need to have the following software installed:

- [Node.js](https://nodejs.org/)
- [Pulumi](https://www.pulumi.com/)

You will need the following:

- AWS account with administrative privileges
- Pulumi account
- AWS Keypair (SSH private key)
- GitHub

The following infrastructure must already exist:

- An AWS VPC with two or more subnets in different availability zones.
- A Route53 Hosted Zone for cluster DNS (can be internal, if linked to the VPC)



## First-time Setup

### Download and Install

Clone this repository:

    git clone git@github.com:schematic-energy/scio.git

Change to the repository directory:

    cd scio

Download dependencies (5-10 minutes):

    npm install

### AWS Credentials

Make sure you have [AWS credentials][creds] available,
for example through environment variables
or the `~/.aws/credentials` file.

[creds]: https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-quickstart.html

### Pulumi Login

Log in to Pulumi, following the printed instructions
to get a Pulumi token via the web interface:

    pulumi login

### Naming Your Stack

Choose a short name for your stack, such as first name + last initial.

This will be your *environment name*.

### Create Your Stack

Create a new Pulumi stack,
replacing `<env>` with your environment name:

    pulumi stack init tetherenergy/<env>

### Configure Your Stack

Create a file named `Pulumi.<env>.yaml`,
replacing `<env>` with your environment name:

Edit `Pulumi.<env>.yaml`, replacing the example values
with those from your AWS account:

```yaml
config:
  aws:allowedAccountIds: '["1234567890"]'     # Your AWS Account ID
  aws:region: us-east-1                       # The region you want to use
  scio:organization: "example"                # The organization name, used to name various artifacts
  scio:vpcId: "vpc-1234569abcde"              # The VPC ID you want to use
  scio:publicDomainName: "example.com"        # The domain name suffix associated with this installation.
                                              # Used to ensure unique S3 bucket names
  scio:route53ZoneId: "Z1234567"              # The ID of the hosted zone you'll use for DNS resolution
  scio:coordinatorDnsPrefix: "scio.<env>  "   # The DNS prefix used to register the coordinator in the hosted zone
  scio:subnets: '["subnet-abc", "subnet-xyz]' # Subnets to deploy into
  scio:allowedCidrs: '["0.0.0.0/0"]'          # Network access whitelist (including Scio deployment itself)
  scio:keypair: "my-keypair"                  # Name of the keypair
  scio:prestoAmiOwner: "407553720128"         # Your AWS account ID
  # The Presto Coordinator AMI name:
  scio:prestoCoordinatorAmi: schematic/presto-coordinator-v24-79562d0
  # The Presto Worker AMI name
  scio:prestoWorkerAmi: schematic/presto-worker-v24-79562d0
  scio:prestoCoordinatorType: m5.large        # Instance type for the coordinator. m5.large is reccomended
  scio:prestoDedicatedWorkers: 1              # Number of EC2 on-demand instances to use as workers
  scio:prestoWorkerType: m5.large             # Worker instance type
  scio:protect: false                         # Set to true to prevent accidental removal of data buckets
  scio:prestoCoordinatorConfig: |
    experimental.max-spill-per-node=130GB
    query.max-memory=60GB
    query.max-memory-per-node=2GB
    query.max-total-memory-per-node=3GB
  scio:prestoWorkerConfig: |
    experimental.max-spill-per-node=130GB
    query.max-memory=60GB
    query.max-memory-per-node=2GB
    query.max-total-memory-per-node=3GB
```

### Deploy

Finally, run Pulumi (5-10 minutes):

    pulumi up

At this point you should have a working Presto cluster
with 1 coordinator and 1 worker.



## Connecting to Presto

The Pulumi stack creates a load-balancer hosted at
`<prefix>.<zone>` where:

- `<prefix>` is the value of `scio:coordinatorDnsPrefix`
  in your `Pulumi.<env>.yaml` file
- `<zone>` is the name domain name of the
  Route53 hosted zone identified by `scio:route53ZoneId`
  in your `Pulumi.<env>.yaml` file

If you have installed the [Presto CLI][cli],
you can connect to the Presto cluster like this:

    presto --server <prefix>.<zone>:8080 --catalog hive

[cli]: https://prestosql.io/docs/current/installation/cli.html



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



## Presto AMIs

Optionally, you can modify the images used to launch the Presto
coordinator and workers.

Clone the [presto-ami](https://github.com/schematic-energy/presto-ami)
repository and follow its instructions to build and install AMIs in
your AWS account. Take note of the names of the AMIs it creates, both
the coordinator and the worker.

Edit the following lines in your `Pulumi.<env>.yaml` file
to use the new AMIs:

    scio:prestoCoordinatorAmi: tether/presto-coordinator-v27-89b994d
    scio:prestoWorkerAmi: tether/presto-worker-v27-89b994d



## Updating the Stack

After the first-time setup,
you can edit `Pulumi.<env>.yaml`
and then run the following in this directory:

    pulumi login
    pulumi stack select tetherenergy/<env>
    pulumi up



## Destroying the Stack

To tear down all of the AWS resources created by Pulumi,
run in this directory:

    pulumi login
    pulumi stack select tetherenergy/<env>
    pulumi destroy

To completely remove the stack from Pulumi,
including all history, run in this directory:

    pulumi stack rm tetherenergy/<env>
