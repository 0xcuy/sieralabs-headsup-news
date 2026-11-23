#!/usr/bin/env python3
"""Heads Up News — Deepgram voice poller (SIERA Labs).

Runs on the Muse VM (NOT on the droplet). Why here: the Deepgram credential
(`custom.deepgram`) is held by the VM's authd and its surrogate (`hsurr:*`)
is only substituted with the real key on VM egress through the runtime
proxy. The droplet cannot call Deepgram itself, and no key — raw or
surrogate — may ever be written to the droplet, an env var, or a file.

Flow: the droplet backend queues voice clips as jobs (POST /api/voice).
This poller polls GET /api/voice-jobs, downloads each clip, transcribes it
with Deepgram nova-2 from this VM (surrogate attached per request via the
dynamic-credentials helper), and POSTs the transcript back to the droplet
(POST /api/voice-result). The glasses app polls the droplet for the result.

Run it detached from a shell that has the runtime proxy env (it inherits
HTTPS_PROXY etc.; without the proxy the VM has no egress at all):
    setsid nohup python3 deepgram_poller.py >> voice-poller.log 2>&1 < /dev/null &
It holds no secret: a fresh surrogate is minted per Deepgram call and kept
only in memory. Nothing credential-like is ever printed or logged.

Deepgram nova-2 costs ~$0.0043/min, so a 4s voice clip is ~$0.0003.
"""

import json
import os
import sys
import time
import traceback
import urllib.error
import urllib.request

sys.path.insert(0, '/opt/muse/skills/custom-connector-setup/bin')
from dynamic_credentials import add_surrogate_to_request, read_json_response

BASE = os.environ.get('VOICE_BASE', 'http://159.89.197.202:8787').rstrip('/')
# Direct droplet IP on purpose: the TLS URL goes through Cloudflare, whose
# bot protection 403s bare urllib requests (seen 23 Nov 2026). The droplet
# API is the poller's own backend, so plain HTTP on the private port is fine.
USER_AGENT = 'HeadsUpNews-VoicePoller/1.0'
POLL_SECONDS = 1.0
MAX_ATTEMPTS = 3
DG_URL = ('https://api.deepgram.com/v1/listen'
          '?model=nova-2&language=en&smart_format=true')


def log(msg):
    print(f'{time.strftime("%Y-%m-%d %H:%M:%S")} [poller] {msg}', flush=True)


def http_json(method, url, body=None, headers=None, timeout=30):
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header('User-Agent', USER_AGENT)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read()


def transcribe(audio_bytes, mime):
    """One Deepgram call. Surrogate attached via the helper; never logged."""
    req = urllib.request.Request(DG_URL, data=audio_bytes, method='POST')
    req.add_header('User-Agent', USER_AGENT)
    req.add_header('Content-Type', mime or 'audio/wav')
    add_surrogate_to_request(req, 'custom.deepgram',
                             allowed_hosts=['api.deepgram.com'])
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = read_json_response(resp)
    alt = data['results']['channels'][0]['alternatives'][0]
    return (alt.get('transcript') or '').strip()


def post_result(job_id, transcript=None, error=None):
    body = json.dumps({'jobId': job_id,
                       'transcript': transcript,
                       'error': error}).encode()
    http_json('POST', f'{BASE}/api/voice-result', body,
              {'Content-Type': 'application/json'}, timeout=15)


def main():
    log(f'started, backend={BASE}')
    attempts = {}
    while True:
        try:
            _, raw = http_json('GET', f'{BASE}/api/voice-jobs', timeout=15)
            jobs = json.loads(raw).get('jobs', [])
        except Exception as e:
            log(f'voice-jobs poll failed: {e}')
            time.sleep(POLL_SECONDS)
            continue
        for job in jobs:
            job_id = job['jobId']
            try:
                _, audio = http_json(
                    'GET', f'{BASE}/api/voice/{job_id}/audio', timeout=15)
                # The audio endpoint returns raw bytes, not JSON.
                transcript = transcribe(audio, job.get('mime') or 'audio/wav')
                post_result(job_id, transcript=transcript)
                attempts.pop(job_id, None)
                log(f'job {job_id[:8]} "{transcript}"')
            except urllib.error.HTTPError as e:
                # Deepgram auth/model errors: don't spin forever.
                detail = e.read()[:200].decode('utf-8', 'replace')
                log(f'job {job_id[:8]} Deepgram HTTP {e.code}: {detail}')
                try:
                    post_result(job_id, error='stt_failed')
                except Exception:
                    pass
                attempts.pop(job_id, None)
            except Exception:
                n = attempts.get(job_id, 0) + 1
                attempts[job_id] = n
                log(f'job {job_id[:8]} attempt {n} failed:\n'
                    + traceback.format_exc(limit=2))
                if n >= MAX_ATTEMPTS:
                    try:
                        post_result(job_id, error='stt_failed')
                    except Exception:
                        pass
                    attempts.pop(job_id, None)
        time.sleep(POLL_SECONDS)


if __name__ == '__main__':
    main()
