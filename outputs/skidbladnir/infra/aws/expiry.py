import os
from datetime import datetime, timezone

def expired_ids(reservations, fleet_id, now):
    result=[]
    for reservation in reservations:
        for instance in reservation.get('Instances', []):
            tags={tag['Key']:tag['Value'] for tag in instance.get('Tags', [])}
            if tags.get('skidbladnir:fleet')!=fleet_id or instance.get('State',{}).get('Name') not in ('pending','running','stopping','stopped'):
                continue
            try:
                expiry=datetime.fromisoformat(tags['skidbladnir:expires'].replace('Z','+00:00'))
                if expiry.tzinfo is None:continue
            except (KeyError,ValueError,TypeError):continue
            if expiry<=now:result.append(instance['InstanceId'])
    return result

def handler(event, context):
    import boto3
    fleet=os.environ['FLEET_ID']
    client=boto3.client('ec2')
    pages=client.get_paginator('describe_instances').paginate(Filters=[{'Name':'tag:skidbladnir:fleet','Values':[fleet]}])
    terminated=[]
    for page in pages:
        ids=expired_ids(page.get('Reservations',[]),fleet,datetime.now(timezone.utc))
        for start in range(0,len(ids),100):
            batch=ids[start:start+100]
            client.terminate_instances(InstanceIds=batch)
            terminated.extend(batch)
    print({'fleet':fleet,'terminationRequested':terminated})
    return {'terminationRequested':terminated}
