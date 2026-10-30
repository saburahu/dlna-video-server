# Programme-relative recording timeline (v0.4.4 development)

This development feature is **OFF by default**. Developers select it with
`PT3_PROGRAMME_TIMELINE=1` at process startup. Do not enable it on an existing
server until its separate validation is authorized. There is no new user-facing
folder, management tab, per-recording registration, or separate playback server.
`PT3_BIND_LOOPBACK=1` is available for isolated HTTP tests; SSDP must also be disabled
there with the existing `PT3_DISABLE_SSDP=1` switch.

## Directory and compatibility contract

Normal recording views keep their existing containers, order, 200-item SOAP page
limit, and 1000-child virtual-folder projection. Each physical recording contributes
one visible item: an eligible programme view, otherwise its existing whole view.
Ordinary video catalogue playback is not changed.

Programme items use `programme:<source-id>:<event-key>` and `/programme-v1/` resources.
Folder references have a validated, encoded legacy-reference suffix, preserving
that folder's parent. Metadata requests reconstruct the corresponding legacy view
internally, then render the requested programme descriptor. No additional visible
"whole recording" or "programme" folder is created.

Old recording ObjectIDs, folder references and `/media/` URLs remain addressable
whole-recording **compatibility aliases**. Old Metadata returns the original URL,
whole duration and a valid existing parent container. Once a programme view is
visible, its old alias is not also enumerated in that container. Thus alias
resolvability and parent-container validity are maintained; historical aliases are
not asserted to be current canonical children. Cached parent navigation sees the
current one-item projection after its UpdateID changes. This distinction is
necessary to preserve old NPT meaning without showing duplicate items.

Never reinterpret an old whole NPT as a programme NPT. A programme URL revision
binds source stat, event, complete PCR-index digest, bounds and transport profile.
Invalid/stale revisions return 410 without falling back to whole media. Disabled
or older software rejects the distinct route instead of ignoring an unknown
query and returning a different timeline. A new programme identity separates
receiver resume positions from old whole-recording positions.

## Eligibility and clocks

Use confirmed full-scan/reservation event selection, exact service/TSID/ONID scope,
single-service PAT evidence, source size/mtime, PCR PID, continuous whole PCR index,
whole-file event-set evidence identifying exactly one fully recorded selected event,
identified broadcast service, a stable file, and a completely recorded programme.
The current output transport is the existing buffered 188-to-192 TS profile.
No filename, receiver model, UDN or sample fingerprint is an input permit.

Initial recording origin and whole-range consistency are distinct. The existing
250ms whole-range classification is not relaxed. A verified initial origin may
support a programme view when the whole range is labelled inconsistent only if
there is one clock segment, at least three whole anchors and finite full-file
spread no greater than the initial origin's one-second TOT quantisation allowance.
This is a bounded transport-clock estimate, not calibrated sub-second broadcast
UTC. Unsupported spread, missing anchors, partial programmes, ambiguous events,
service/PCR mismatch, discontinuity, source changes or invalid caches fall back to
the legacy whole behaviour. Existing legacy refusals are not bypassed.

For eligible content:

    source NPT = programme NPT + (scheduled start - recording origin)

Programme resources retain the existing time-seek-only (OP10) transport contract.
The existing Content Packet handler rejects byte Range requests with 400; no
additional byte-seek capability is advertised or introduced.

The chosen source packet and response NPT agree. Content Packet alignment is local
to the programme view. Its duration, size, HEAD, GET and TimeSeekRange use the same
bounds. PCR/PTS, TTS generation and pacing are not rewritten to fake an origin.

Individually trusted initial and whole-range origins must also agree within the
existing 250ms range criterion; contradictory clock epochs fall back to whole.

## Metadata, preparation and updates

Eligible recording DIDL uses videoItem, channel metadata, verified REGZA service
IDs, scheduled start/end and programme-start dc:date. Whole aliases retain the
recording-origin date. recordedStartDateTime is not added by this feature.
Descriptors resolve metadata by source identity; the new resource prefix does
not rely on the old development URL-guessing hook.

The existing low-priority metadata worker reuses valid PCR caches. Older summaries
only retained the primary event, which cannot exclude a second complete programme.
When full event-set evidence is missing, enabling this development feature requires
one whole-file EIT pass through that same bounded/serial/playback-prioritized worker.
A prefix is not accepted as proof that another programme is absent. Existing origin
and channel-only supplementation can still use its bounded prefix. Unknown or
multiple-event evidence falls back to whole recording and is retained to avoid
repeating unsupported work. No cache schema bump or new
database is introduced; added optional schema-2 metadata remains readable by older
software. Original cache files are not rewritten merely by Browse.

Normal Browse does not read a complete PCR index or scan TS. It checks small,
validated metadata and compact in-memory plans. Missing plans request the existing
background queue. That worker prepares geometry once; bounded maps keep no full
PCR index or full metadata per plan. An explicit saved programme Metadata/GET can
validate its existing index directly without a TS scan. Source/index availability
and metadata changes update the existing SystemUpdateID/GENA machinery. A fresh
process revision prevents old directory-cache epochs from being reused.

## Boundaries and validation status

Programme start/end can split AAC/PES/GOP units. Initial AAC and final video
boundary warnings remain unresolved; ordinary sliced Seek can show similar
transients, while the programme's new permanent end is a separate quality concern.
No guard, timestamp rewrite, re-encode or audit relaxation has been introduced.
Independent audio/video decode is not proof of clean boundaries or receiver
acceptance. Existing MPEG/JIT/64ms audit paths are unchanged.

Tests cover automatic preparation from old caches, one-item Browse, folder aliases,
virtual paging, legacy Metadata and URLs, HEAD/GET/Seek source bytes, revision
rejection, corrupted metadata recovery, GENA, reconnect/cancellation cleanup,
restart and disabling the feature. Synthetic tests and PC HTTP do not extend
previous receiver observations into full-length/EOF guarantees. Product integration
must be verified through the normal directory once separately enabled; the earlier
isolated prototype remains evidence only for that prototype's receiver behaviour.
