import json
from pathlib import Path
import unittest


class IsolationTest(unittest.TestCase):
    def test_network_is_new_private_and_unconnected(self):
        template = json.loads((Path(__file__).parent / 'acceptance.template.json').read_text())
        self.assertEqual(set(template['Parameters']), {'FleetId'})
        resources = template['Resources']
        forbidden = {'AWS::EC2::VPCPeeringConnection', 'AWS::EC2::TransitGatewayAttachment',
                     'AWS::EC2::InternetGateway', 'AWS::EC2::NatGateway', 'AWS::EC2::Route'}
        self.assertFalse(forbidden.intersection(r['Type'] for r in resources.values()))
        for resource in resources.values():
            if 'VpcId' in resource.get('Properties', {}):
                self.assertEqual(resource['Properties']['VpcId'], {'Ref': 'TestVpc'})
        subnet = resources['TestSubnet']['Properties']
        self.assertFalse(subnet['MapPublicIpOnLaunch'])
        worker = resources['WorkerSecurityGroup']['Properties']
        self.assertFalse(worker.get('SecurityGroupIngress'))
        self.assertEqual(worker['SecurityGroupEgress'], [
            {'IpProtocol': 'tcp', 'FromPort': 443, 'ToPort': 443, 'CidrIp': subnet['CidrBlock']}])


if __name__ == '__main__':
    unittest.main()
