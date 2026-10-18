import unittest
from datetime import datetime,timezone
from expiry import expired_ids
class ExpiryTest(unittest.TestCase):
 def test_scope_expiry_and_state(self):
  now=datetime(2026,10,15,tzinfo=timezone.utc)
  def item(id,fleet='owned',expiry='2026-10-14T00:00:00Z',state='running'):
   return {'InstanceId':id,'State':{'Name':state},'Tags':[{'Key':'skidbladnir:fleet','Value':fleet},{'Key':'skidbladnir:expires','Value':expiry}]}
  items=[item('expired'),item('foreign',fleet='other'),item('future',expiry='2030-01-01T00:00:00Z'),item('bad',expiry='bad'),item('naive',expiry='2026-01-01'),item('gone',state='terminated')]
  self.assertEqual(expired_ids([{'Instances':items}],'owned',now),['expired'])
if __name__=='__main__':unittest.main()
