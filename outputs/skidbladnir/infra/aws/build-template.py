from pathlib import Path
import json
root=Path(__file__).resolve().parent
ref=lambda name:{'Ref':name}
sub=lambda value:{'Fn::Sub':value}
get=lambda name,attribute:{'Fn::GetAtt':[name,attribute]}
assume=lambda service:{'Version':'2012-10-17','Statement':[{'Effect':'Allow','Principal':{'Service':service},'Action':'sts:AssumeRole'}]}
resources={
 'WorkerRole':{'Type':'AWS::IAM::Role','Properties':{'AssumeRolePolicyDocument':assume('ec2.amazonaws.com'),'ManagedPolicyArns':[sub('arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore')]}},
 'WorkerProfile':{'Type':'AWS::IAM::InstanceProfile','Properties':{'Roles':[ref('WorkerRole')]}},
 'ExpiryRole':{'Type':'AWS::IAM::Role','Properties':{'AssumeRolePolicyDocument':assume('lambda.amazonaws.com'),'Policies':[{'PolicyName':'ExpireOwnedInstances','PolicyDocument':{'Version':'2012-10-17','Statement':[
 {'Effect':'Allow','Action':'ec2:DescribeInstances','Resource':'*'},
 {'Effect':'Allow','Action':'ec2:TerminateInstances','Resource':sub('arn:${AWS::Partition}:ec2:${AWS::Region}:${AWS::AccountId}:instance/*'),'Condition':{'StringEquals':{'ec2:ResourceTag/skidbladnir:fleet':ref('FleetId')}}},
 {'Effect':'Allow','Action':['logs:CreateLogGroup','logs:CreateLogStream','logs:PutLogEvents'],'Resource':sub('arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/skidbladnir-${FleetId}:*')}
 ]}}]}},
 'ExpiryFunction':{'Type':'AWS::Lambda::Function','Properties':{'FunctionName':sub('skidbladnir-${FleetId}'),'Runtime':'python3.13','Handler':'index.handler','Role':get('ExpiryRole','Arn'),'Timeout':60,'MemorySize':128,'Environment':{'Variables':{'FLEET_ID':ref('FleetId')}},'Code':{'ZipFile':(root/'expiry.py').read_text()}}},
 'ExpiryLog':{'Type':'AWS::Logs::LogGroup','Properties':{'LogGroupName':sub('/aws/lambda/skidbladnir-${FleetId}'),'RetentionInDays':14}},
 'ExpiryRule':{'Type':'AWS::Events::Rule','Properties':{'ScheduleExpression':'rate(1 minute)','State':'ENABLED','Targets':[{'Arn':get('ExpiryFunction','Arn'),'Id':'ExpireWorkers','RetryPolicy':{'MaximumRetryAttempts':2,'MaximumEventAgeInSeconds':300}}]}},
 'ExpiryPermission':{'Type':'AWS::Lambda::Permission','Properties':{'FunctionName':ref('ExpiryFunction'),'Action':'lambda:InvokeFunction','Principal':'events.amazonaws.com','SourceArn':get('ExpiryRule','Arn'),'SourceAccount':ref('AWS::AccountId')}},
 'ExpiryErrors':{'Type':'AWS::CloudWatch::Alarm','Properties':{'AlarmDescription':'Skidbladnir expiration failed. Inspect the cleanup function and owned instances.','Namespace':'AWS/Lambda','MetricName':'Errors','Dimensions':[{'Name':'FunctionName','Value':ref('ExpiryFunction')}],'Statistic':'Sum','Period':60,'EvaluationPeriods':1,'Threshold':1,'ComparisonOperator':'GreaterThanOrEqualToThreshold','TreatMissingData':'notBreaching'}}
}
template={'AWSTemplateFormatVersion':'2010-09-09','Description':'Skidbladnir independent fleet expiration and SSM instance profile','Parameters':{'FleetId':{'Type':'String','AllowedPattern':'[a-zA-Z0-9-]{8,40}','Description':'Unique fleet identity, shared with the local provider configuration'}},'Resources':resources,'Outputs':{'FleetId':{'Value':ref('FleetId')},'InstanceProfileName':{'Value':ref('WorkerProfile')},'ExpiryRuleName':{'Value':ref('ExpiryRule')},'ExpiryFunctionName':{'Value':ref('ExpiryFunction')},'ExpiryAlarmName':{'Value':ref('ExpiryErrors')}}}
(root/'cleanup.template.json').write_text(json.dumps(template,indent=2)+'\n')
