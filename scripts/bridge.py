#!/usr/bin/env python3
"""Authenticated, loopback-only job bridge. Run in foreground; never retries writes."""
import argparse, hmac, json, os, secrets, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CONFIG = Path.home() / '.codex/figma-componentize-bridge.json'
ALLOWED = {'null', 'https://www.figma.com', 'https://figma.com'}
class State:
    def __init__(self, token):
        self.token, self.session, self.last_seen = token, None, 0
        self.jobs, self.lock = {}, threading.Lock()
    def connected(self):
        return self.session is not None and time.time() - self.last_seen < 12

def handler(state):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def respond(self, status, payload):
            data = json.dumps(payload).encode()
            self.send_response(status)
            origin = self.headers.get('Origin')
            if origin in ALLOWED:
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers(); self.wfile.write(data)
        def allowed(self):
            origin = self.headers.get('Origin')
            if origin is not None and origin not in ALLOWED:
                self.respond(403, {'error':'Origin not allowed'}); return False
            if self.path not in ('/health', '/bootstrap') and not hmac.compare_digest(self.headers.get('Authorization',''), 'Bearer '+state.token):
                self.respond(401, {'error':'Token required'}); return False
            return True
        def do_OPTIONS(self):
            if self.headers.get('Origin') not in ALLOWED:
                self.respond(403, {'error':'Origin not allowed'})
            else: self.respond(200, {})
        def do_GET(self):
            if not self.allowed(): return
            with state.lock:
                if self.path == '/health': return self.respond(200, {'service':'figma-componentize'})
                if self.path == '/bootstrap': return self.respond(200, {'url':'http://127.0.0.1:'+str(self.server.server_port), 'token':state.token})
                if self.path == '/status':
                    return self.respond(200, {'connected':state.connected(), 'lastSeen':state.last_seen, 'target':state.session.get('target') if state.session else None})
                if self.path.startswith('/jobs/'):
                    job = state.jobs.get(self.path[len('/jobs/'):])
                    return self.respond(200 if job else 404, job or {'error':'Unknown requestId'})
                self.respond(404, {'error':'Not found'})
        def do_POST(self):
            if not self.allowed(): return
            try:
                size = int(self.headers.get('Content-Length','0'))
                if not 0 < size <= 8_000_000: raise ValueError('Invalid body size')
                body = json.loads(self.rfile.read(size))
                if not isinstance(body, dict): raise ValueError('Object required')
                with state.lock: self.dispatch(body)
            except (ValueError, TypeError, KeyError) as exc:
                self.respond(400, {'error':str(exc)})
        def dispatch(self, body):
            now = time.time()
            if self.path == '/connect':
                session = body.get('sessionId')
                if not isinstance(session,str) or not session: raise ValueError('sessionId required')
                if state.connected() and state.session['id'] != session:
                    return self.respond(409, {'error':'Another plugin is connected; disconnect it first'})
                state.session = {'id':session, 'target':body.get('target')}
                state.last_seen = now
                return self.respond(200, {'connected':True})
            if self.path == '/jobs':
                request_id, command, args = body['requestId'], body['command'], body.get('args',{})
                if not isinstance(request_id,str) or not 1 <= len(request_id) <= 128: raise ValueError('Invalid requestId')
                if command not in ('ping','scan','apply','verify','clear') or not isinstance(args,dict): raise ValueError('Invalid command/args')
                existing = state.jobs.get(request_id)
                if existing:
                    if existing['command'] != command or existing['args'] != args:
                        return self.respond(409, {'error':'requestId reused with different payload'})
                    return self.respond(200, existing)
                if not state.connected(): return self.respond(409, {'error':'No recently connected plugin'})
                if any(j['status'] in ('queued','delivered') for j in state.jobs.values()):
                    return self.respond(409, {'error':'A job is still pending; resolve it before submitting another'})
                job = {'requestId':request_id,'command':command,'args':args,'status':'queued','sessionId':state.session['id'],'createdAt':now}
                state.jobs[request_id] = job
                return self.respond(202, job)
            if self.path in ('/poll','/result','/disconnect'):
                if not state.session or body.get('sessionId') != state.session['id']:
                    return self.respond(409, {'error':'Plugin session mismatch; reconnect explicitly'})
                state.last_seen = now
                if self.path == '/disconnect':
                    state.session = None
                    return self.respond(200, {'connected':False})
                if self.path == '/poll':
                    for job in state.jobs.values():
                        if job['status']=='queued' and job['sessionId']==state.session['id']:
                            job['status']='delivered'; job['deliveredAt']=now
                            return self.respond(200, {'job':job})
                    return self.respond(200, {'job':None})
                job = state.jobs.get(body['requestId'])
                if not job or job['sessionId'] != state.session['id']:
                    return self.respond(409, {'error':'Unknown job for this plugin session'})
                if job['status'] != 'done':
                    job.update(status='done', completedAt=now)
                    if 'error' in body: job['error']=body['error']
                    else: job['result']=body.get('result')
                return self.respond(200, {'received':True})
            self.respond(404, {'error':'Not found'})
    return Handler

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8766)
    parser.add_argument('--config', type=Path, default=CONFIG)
    options = parser.parse_args()
    token = secrets.token_urlsafe(32)
    server = ThreadingHTTPServer(('127.0.0.1', options.port), handler(State(token)))
    options.config.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(options.config, os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd,'w') as stream:
        json.dump({'url':f'http://127.0.0.1:{server.server_port}', 'token':token, 'pid':os.getpid()},stream)
    print(f'Bridge ready at http://127.0.0.1:{server.server_port}; token in {options.config}', flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()
if __name__ == '__main__': main()
