#!/usr/bin/env python3
"""Heads Up News — Deepgram voice poller (SIERA Labs), DROPLET version.

Runs on the 32GB droplet as a systemd service (headsup-voice-poller),
NOT on the Muse VM. Why: the VM's Deepgram credential (`custom.deepgram`)
never reaches Deepgram — the authd surrogate swap is broken from the VM
(proven 23 Nov 2026: every TTS/STT call 401s, Deepgram console shows
0 requests / $0 used all week; the E2B list call from the VM 401s with
"authorization header is missing" the same way). Do NOT use
dynamic_credentials or any hsurr surrogate here.

Auth is FILE-based: the Deepgram key is read from
/root/.config/deepgram/api-key (mode 600, root only) and used as
`Authorization: Token <key>`. The key value is NEVER printed or logged.
If the key file is missing, the poller logs "waiting for key file" and
retries every 30s instead of crashing — the user places the key at the
staging path /home/siera/deepgram-api-key (writable by user siera, no
sudo) and root moves it to /root/.config/deepgram/.

Flow: the droplet backend (same box, 127.0.0.1:8787) queues voice clips
as jobs (POST /api/voice). This poller polls GET /api/voice-jobs,
downloads each clip, transcribes it with Deepgram nova-2, and POSTs the
transcript back (POST /api/voice-result). The glasses app polls the
backend for the result.

Deepgram nova-2 costs ~$0.0043/min, so a 4s voice clip is ~$0.0003.
"""

import json
import os
import time
import traceback
import urllib.error
import urllib.request

BASE = os.environ.get('VOICE_BASE', 'http://127.0.0.1:8787').rstrip('/')
KEY_FILE = os.environ.get(
    'DEEPGRAM_API_KEY_FILE', '/root/.config/deepgram/api-key')
USER_AGENT = 'HeadsUpNews-VoicePoller/1.0'
POLL_SECONDS = 1.0
KEY_WAIT_SECONDS = 30
MAX_ATTEMPTS = 3
DG_URL = ('https://api.deepgram.com/v1/listen'
          '?model=nova-2&language=en&smart_format=true')


def log(msg):
    print(f'{time.strftime("%Y-%m-%d %H:%M:%S")} [poller] {msg}', flush=True)


def load_key():
    """Read the Deepgram key from disk. Returns None if not present yet.
    The value is never logged."""
    try:
        with open(KEY_FILE, 'r') as f:
            key = f.read().strip()
        return key or None
    except OSError:
        return None


def http_json(method, url, body=None, headers=None, timeout=30):
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header('User-Agent', USER_AGENT)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read()


def transcribe(audio_bytes, mime, key):
    """One Deepgram call with the file-based key. Key never logged."""
    req = urllib.request.Request(DG_URL, data=audio_bytes, method='POST')
    req.add_header('User-Agent', USER_AGENT)
    req.add_header('Content-Type', mime or 'audio/wav')
    req.add_header('Authorization', 'Token ' + key)
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read())
    alt = data['results']['channels'][0]['alternatives'][0]
    return (alt.get('transcript') or '').strip()


def post_result(job_id, transcript=None, error=None):
    body = json.dumps({'jobId': job_id,
                       'transcript': transcript,
                       'error': error}).encode()
    http_json('POST', f'{BASE}/api/voice-result', body,
              {'Content-Type': 'application/json'}, timeout=15)


def main():
    log(f'started, backend={BASE}, key_file={KEY_FILE}')
    attempts = {}
    last_wait_log = 0.0
    while True:
        key = load_key()
        if key is None:
            now = time.time()
            if now - last_wait_log >= KEY_WAIT_SECONDS:
                log(f'waiting for key file: {KEY_FILE}')
                last_wait_log = now
            time.sleep(KEY_WAIT_SECONDS)
            continue
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
                transcript = transcribe(
                    audio, job.get('mime') or 'audio/wav', key)
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
