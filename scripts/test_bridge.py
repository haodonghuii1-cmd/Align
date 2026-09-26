import json, threading, unittest
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from http.server import ThreadingHTTPServer
from bridge import State, handler

class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.state=State('test-token')
        self.server=ThreadingHTTPServer(('127.0.0.1',0),handler(self.state))
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True); self.thread.start()
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()
    def request(self,path,data=None,token='test-token',origin=None):
        headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'}
        if origin: headers['Origin']=origin
        req=Request(f'http://127.0.0.1:{self.server.server_port}'+path,data=json.dumps(data).encode() if data is not None else None,headers=headers)
        try:
            with urlopen(req) as response:return response.status,json.load(response)
        except HTTPError as exc:
            with exc: return exc.code,json.load(exc)
    def test_auth_origin_and_single_session(self):
        self.assertEqual(self.request('/health',token='')[0],200)
        bootstrap_status, bootstrap = self.request('/bootstrap',token='')
        self.assertEqual(bootstrap_status,200)
        self.assertEqual(bootstrap['token'],'test-token')
        self.assertEqual(self.request('/status',token='')[0],401)
        self.assertEqual(self.request('/status',origin='https://evil.example')[0],403)
        self.assertEqual(self.request('/connect',{'sessionId':'a'})[0],200)
        self.assertEqual(self.request('/connect',{'sessionId':'b'})[0],409)
        self.assertEqual(self.request('/poll',{'sessionId':'b'})[0],409)
    def test_no_duplicate_delivery_and_idempotency(self):
        body={'requestId':'one','command':'apply','args':{'scanId':'s'}}
        self.assertEqual(self.request('/jobs',body)[0],409)
        self.request('/connect',{'sessionId':'a'})
        self.assertEqual(self.request('/jobs',body)[0],202)
        self.assertEqual(self.request('/jobs',body)[0],200)
        self.assertEqual(self.request('/poll',{'sessionId':'a'})[1]['job']['requestId'],'one')
        self.assertIsNone(self.request('/poll',{'sessionId':'a'})[1]['job'])
        self.assertEqual(self.request('/jobs',{**body,'requestId':'two'})[0],409)
        self.assertEqual(self.request('/jobs',{**body,'args':{}})[0],409)
        self.request('/result',{'sessionId':'a','requestId':'one','result':{'count':1}})
        self.assertEqual(self.request('/jobs',body)[1]['result'],{'count':1})
        self.assertIsNone(self.request('/poll',{'sessionId':'a'})[1]['job'])
    def test_stale_session_cannot_accept_jobs(self):
        self.request('/connect',{'sessionId':'a'})
        self.state.last_seen=0
        self.assertFalse(self.request('/status')[1]['connected'])
        self.assertEqual(self.request('/jobs',{'requestId':'one','command':'scan'})[0],409)

if __name__=='__main__':unittest.main()
