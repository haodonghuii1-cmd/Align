#!/usr/bin/env python3
"""Submit one command and wait without retrying mutations. JSON output only."""
import argparse, json, sys, time, uuid
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path.home()/'.codex/figma-componentize-bridge.json')
    subs = parser.add_subparsers(dest='action',required=True)
    subs.add_parser('status')
    result = subs.add_parser('result'); result.add_argument('request_id')
    call = subs.add_parser('call'); call.add_argument('command',choices=['ping','scan','apply','verify','clear'])
    call.add_argument('--args-file',type=Path); call.add_argument('--request-id'); call.add_argument('--timeout',type=float,default=120)
    options = parser.parse_args()
    request_id = None
    try:
        config = json.loads(options.config.read_text())
        if not config['url'].startswith('http://127.0.0.1:'): raise ValueError('Bridge must use loopback')
        def request(path, data=None):
            payload = json.dumps(data).encode() if data is not None else None
            req = Request(config['url']+path,data=payload,headers={'Authorization':'Bearer '+config['token'],'Content-Type':'application/json'})
            with urlopen(req,timeout=10) as response: return json.load(response)
        if options.action=='status': output=request('/status')
        elif options.action=='result': output=request('/jobs/'+options.request_id)
        else:
            request_id = options.request_id or str(uuid.uuid4())
            args = json.loads(options.args_file.read_text()) if options.args_file else {}
            output=request('/jobs',{'requestId':request_id,'command':options.command,'args':args})
            deadline=time.monotonic()+options.timeout
            while output['status']!='done':
                if time.monotonic()>=deadline:
                    print(json.dumps({'requestId':request_id,'status':'uncertain','error':'Timed out. Do not resubmit writes. Inspect result with this requestId and the Figma document.'})); return 2
                time.sleep(.5); output=request('/jobs/'+request_id)
        print(json.dumps(output,ensure_ascii=False,indent=2))
        return 1 if 'error' in output else 0
    except (OSError, ValueError, HTTPError, URLError) as exc:
        print(json.dumps({'error':str(exc),'requestId':request_id,'note':'If submission may have reached the bridge, inspect this requestId before retrying.'})); return 1
if __name__=='__main__': sys.exit(main())
