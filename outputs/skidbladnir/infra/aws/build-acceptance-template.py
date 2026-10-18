"""Build a disposable network without referencing existing AWS resources."""
import json
from pathlib import Path

root = Path(__file__).resolve().parent
template = json.loads((root / 'cleanup.template.json').read_text())
ref = lambda name: {'Ref': name}
sub = lambda text: {'Fn::Sub': text}
tags = [{'Key': 'skidbladnir:fleet', 'Value': ref('FleetId')}]
resources = template['Resources']
resources.update({
    'TestVpc': {'Type': 'AWS::EC2::VPC', 'Properties': {
        'CidrBlock': '10.231.0.0/24', 'EnableDnsSupport': True,
        'EnableDnsHostnames': True, 'Tags': tags}},
    'TestSubnet': {'Type': 'AWS::EC2::Subnet', 'Properties': {
        'VpcId': ref('TestVpc'), 'CidrBlock': '10.231.0.0/26',
        'MapPublicIpOnLaunch': False, 'Tags': tags}},
    'WorkerSecurityGroup': {'Type': 'AWS::EC2::SecurityGroup', 'Properties': {
        'GroupDescription': 'Disposable acceptance worker with no inbound access',
        'VpcId': ref('TestVpc'), 'Tags': tags,
        'SecurityGroupEgress': [{'IpProtocol': 'tcp', 'FromPort': 443,
                                 'ToPort': 443, 'CidrIp': '10.231.0.0/26'}]}},
    'EndpointSecurityGroup': {'Type': 'AWS::EC2::SecurityGroup', 'Properties': {
        'GroupDescription': 'SSM endpoints for disposable workers only',
        'VpcId': ref('TestVpc'), 'Tags': tags,
        'SecurityGroupIngress': [{'IpProtocol': 'tcp', 'FromPort': 443,
                                  'ToPort': 443, 'SourceSecurityGroupId': ref('WorkerSecurityGroup')}],
        'SecurityGroupEgress': [{'IpProtocol': 'tcp', 'FromPort': 443,
                                 'ToPort': 443, 'CidrIp': '127.0.0.1/32'}]}},
})
for name, service in [('SsmEndpoint', 'ssm'), ('MessagesEndpoint', 'ssmmessages')]:
    resources[name] = {'Type': 'AWS::EC2::VPCEndpoint', 'Properties': {
        'VpcEndpointType': 'Interface', 'VpcId': ref('TestVpc'),
        'SubnetIds': [ref('TestSubnet')],
        'SecurityGroupIds': [ref('EndpointSecurityGroup')],
        'ServiceName': sub('com.amazonaws.${AWS::Region}.' + service),
        'PrivateDnsEnabled': True}}
template['Description'] = 'Disposable Skidbladnir acceptance network and expiration. No existing resource inputs.'
template['Outputs'].update({
    'VpcId': {'Value': ref('TestVpc')},
    'SubnetId': {'Value': ref('TestSubnet')},
    'SecurityGroupId': {'Value': ref('WorkerSecurityGroup')},
})
(root / 'acceptance.template.json').write_text(json.dumps(template, indent=2) + '\n')
