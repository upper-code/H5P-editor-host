# Using the H5P Editor Host

This guide covers how to embed the host, provision its libraries, configure it
and deploy it.

The host is meant to run behind a surrounding application that supplies
authentication, the user-facing interface and a reverse proxy in front of the
API. Throughout this repository that surrounding application is called
**Shelf** — a placeholder name used for illustration, not a real product.
Replace it with your own editor application.

## Embedding the host in a Shelf

Shelf loads the editor page in an `<iframe>` and reverse-proxies the
`/h5p-editor-core/*` namespace to the host. The host manages the
H5P runtime and storage; Shelf provides authentication and the surrounding
interface:

- the H5P browser runtime is initialized by the editor page;
- the iframe and Shelf (the parent page) exchange `postMessage` events
  (`ready` / `changed` / `saving` / `saved` / `error`, and an inbound `save`;
  `changed` is posted once per dirty period when the editor holds unsaved
  input, so Shelf can warn before its page is left — it carries no content);
- `ready` (`{ contentId, revision, bookId }`, see below) means the editor form
  itself is usable, not just that its runtime scripts loaded: the content-type
  list has resolved and, for content that already names one, that type's
  semantics have too. `save()` refuses (an `error` DTO, not a
  `saving`/silence) before `ready` arrives, and `error` can itself arrive
  instead of `ready` — a content-type list or semantics load that fails, or
  one that simply never finishes within `EDITOR_READY_TIMEOUT_MS` (60 s after
  the editor's own internal iframe loads) — so a caller must not assume
  `ready` is coming just because nothing failed yet. Such a load failure's
  `error` carries the `revision` the page read for stored content, so the
  content can still be replaced by a version import conditioned on it;
- stored content that names a library version this host does not have
  installed (its main library or a nested one) opens no editor: `GET
/api/v1/content/:contentId/edit` lists them as `missingLibraries` (`[{
library, upgrade, reason }]`, `upgrade` being the newest installed version
  of the same library, or `null` when only older ones are installed —
  content is never downgraded — and `reason` `"not-installed"`), and the
  page posts `error` with `code: "library-missing"`, the `revision` and
  `notInstalled: true` — the stored content cannot be played or downloaded
  either (the player page fails, the download answers `404`) until an
  upgraded save. The same goes for an installed nested version that the
  installed container no longer lists in the field holding it (`reason:
"not-accepted"`, `upgrade` being the version that field lists when it is
  newer and installed): a container patch replaced in place can drop or
  re-version such an option, and the editor would clear that part of the
  content, the next save losing it (provisioning refuses such a patch unless
  told otherwise, see "Runtime assets and libraries" below). When every
  listed version is of this kind, the `error` carries `notInstalled: false`:
  only the editor is blocked, the player and the download work as before.
  `notInstalled` is additive (it bumped no `contractVersion`): a host older than
  it sends none, which an embedder should read as `true`; only the
  `library-missing` error carries it, not `library-upgrade-failed`. The check reads
  the semantics of every installed library the content nests; when one
  cannot be read the
  edit model answers `500` rather than open an editor the check did not
  cover. The page opens a modal dialog listing each version with its
  `upgrade` (`H5P.Book 1.0 → H5P.Book 1.2`; a `not-accepted` one marked as
  such, one without an upgrade as having no newer version). These are the
  versions that keep the editor from opening the content; the upgrade itself
  moves a nested library to the version its container accepts, which may be
  an older installed one than listed, and may move installed nested versions
  as well.
  When every listed version has an upgrade, the dialog's **Upgrade** button
  runs the H5P core's own
  content upgrade in the browser (the installed versions' `upgrades.js`
  hooks for every step from the stored version; a library
  without one only has its version replaced; nested libraries go to the
  version their installed container's semantics name) and opens the result
  in the editor unsaved — `ready`, then `changed` — so nothing is written
  until the author saves. A failed upgrade posts `error` with `code:
"library-upgrade-failed"`, shows the reason in the dialog and leaves the
  button available. Otherwise the dialog only explains. Escape or **Close**
  (not while an upgrade runs) closes it without an editor; the page keeps
  the message and, for content that can be upgraded, a button that opens the
  dialog again. Such content
  can be overwritten at all — by that save or by a version import over its
  id — because an update whose stored parameters cannot be scanned for
  their media (h5p-server reads the stored library's semantics for that)
  takes the files actually stored with the content instead: those the new
  parameters reference stay, the rest are removed as unreferenced
  (`src/h5p/missing-library-update.ts`) — except in a book with an encrypted
  exam, which keeps them (see the package import below);
- stored content the editor can open as it is (`missingLibraries` empty) but
  whose main library has a newer installed version carries `availableUpgrade:
{ library, upgrade }` in the edit model — the stored main library and the
  newest installed newer `major.minor` of it, chosen like the `upgrade` of
  `missingLibraries` — and `availableUpgrade: null` otherwise: no newer
  version, blocked content (the dialog above covers it), a main library not
  spelled `Name major.minor`, or a root `vmbExam` in the parameters (the
  upgrade cannot see into the encrypted chapter). Only the main library is
  named: the upgrade moves nested libraries to the versions the new
  container's semantics name. The field is additive (it bumped no
  `contractVersion`). The page opens the editor as usual and shows a notice above it,
  not modal, naming both versions, with **Upgrade** and **Dismiss**.
  **Upgrade** runs the same content upgrade as the dialog on what the editor
  holds — the state a save would send, unsaved input included — with the
  editor inert meanwhile, and rebuilds the editor on the result, unsaved. It
  waits while the editor has a request running (an upload writes its file
  into the content only once it completes) and is cancelled when the
  content changes or the editor starts a request while it runs.
  The parent gets `changed` (unless the frame already reported unsaved
  input) and no second `ready`; a `save` sent while the upgrade runs or the
  editor is rebuilt is refused with an `error` (no `code`) and can simply be
  repeated. A failed upgrade is shown in the notice only — the parent gets
  no `error`, the editor stays as it was — and so is an upgraded editor that
  fails to load (before it is usable in the sense of `ready`), which is
  rebuilt from the state the upgrade started from.
  **Dismiss** only hides the notice: the H5P editor's own save still
  upgrades content to the newest installed version of its main library
  before sending it (`getContent` in the vendored editor), so declining keeps
  the older version's form until the save, not the older version;
- Shelf authenticates each proxied request with an `X-Distributor-Id`
  tenant header and the shared `X-H5P-Host-Secret`. The proxy sets both
  itself and never forwards a value the browser sent under either name: the
  host takes the tenant id as it arrives, creating the tenant if it is new.
  Ids are case-sensitive; on a data directory that ignores case (the macOS
  and Windows default) an id that differs only in letter case from an
  existing tenant's is refused with `409` rather than given that tenant's
  directory.
  Neither header is CORS-safelisted, but `/h5p-editor-core/*` is same-origin
  for Shelf's own pages, so any script there can send them without a
  preflight; a proxy that passed a client's `X-Distributor-Id` through would
  let it read and write another tenant's content;
- `GET /ready` reports `contractVersion` (the number of this save-body /
  DTO / header / route contract, currently **10**) so a Shelf built against
  another version can refuse to go live instead of failing on the first save,
  and `bundle` — the version and checksum of the library bundle the runtime
  directory was provisioned from (`null` for a plain-directory install);
- every content mutation is a journalled transaction. Shelf may send an
  `Idempotency-Key` — a UUID in lower case (`8-4-4-4-12` hex digits; any
  other form is refused with `400`, an empty value counts as none); a
  replay returns the first answer
  instead of writing again — an `If-Match` revision (a save over content changed elsewhere is
  refused with `409`) and an `X-Max-Delta-Bytes` allowance (`413` when the
  write would exceed it). A key reused for a different write — another body,
  target, `If-Match` or import mode — is refused with
  `409 operation-id-reused` (the `error` text, which older embedders match,
  is unchanged). The answer carries an `operationId` — quoted back to
  `POST /api/v1/operations/:id/ack` once Shelf has accounted for the byte
  delta — and, for a save, the content's new `revision`; the `saved` DTO
  carries the `operationId` too. `GET /api/v1/operations/:id` answers the
  recorded result of a completed operation (`404` otherwise) — until it is
  acknowledged, and for `H5P_HOST_OPERATION_RETENTION_MS` after that (a
  generation write's goes past that window even unacknowledged).
  Completed writes nobody acknowledged are
  listed by `GET /api/v1/pending-usage`. Since contract version 8, a present
  `If-Match` always conditions a mutation of existing content: an empty value,
  `""` after unquoting, or whitespace trimmed by HTTP mismatches and is refused
  with `409`, just as a download refuses it with `412`. Only an absent header
  permits an unconditional operation. Version 7 treated empty values as no
  condition on mutations; embedders must now preserve them when forwarding.
  Deploy Host and Shelf together at version 8. Creating new content has no prior
  revision to compare; idempotent replays still return the recorded result of
  an already completed operation;
- `GET /api/v1/contents` lists the tenant's content, newest first, as
  `{ content: [{ id, title, mainLibrary, bookId, updatedAt }] }`: `bookId` is
  the book id in `h5p.json`'s `authorComments` ("Book id" below), `null` when
  there is none or an invalid one — such a book cannot take a new version
  until it has a valid id, so Shelf offers the version import only for items
  with a `bookId`; `updatedAt` is the time of the last save. `bookId` is new
  in contract version 9; since version 10 it is the validated, lower-cased
  UUID (version 9 answered the first declaration's raw text, whatever it
  was): deploy Host and Shelf together at version 10;
- a package is imported as new content with `POST /api/v1/import/h5p` (`201`)
  or over an existing content — a new version of it, under the same id — with
  `POST /api/v1/import/h5p/:contentId` (`200`; `404` for an unknown id, `400`
  for one that is not numeric, `new` included). Both answer `415` to a file
  not named `*.h5p`. The replacement is a mutation like a save: same headers,
  a signed `deltaBytes`, and the stored content stays as it was if the package
  cannot be unpacked or saved. Both import routes reject a package missing
  referenced local media with `422 media-missing`, before H5P can discard the
  references; a replacement leaves the previous content and media intact.
  `GET /api/v1/content/:contentId/metadata`
  answers `title`, `mainLibrary` and `authorComments` from the stored
  `h5p.json` (each `null` when absent; `400`/`404` as above), so a caller can
  compare them with a package before importing it over that content, and —
  since contract version 10 — the content's `revision` and `bookId` (below),
  read under one shared lock: the pair belongs to one stored revision, and
  the `revision` is what the write the caller decides on presents as
  `If-Match`. A content directory without `content.json` (no stored revision)
  answers `404` like an unknown id;
- a package naming library versions this host does not have is refused by
  both import routes with `400` (`install-missing-libraries`, h5p-server's
  own error) — unless the request carries
  `X-Import-Outdated-Libraries: keep` (that exact value; any other is
  ignored). Then, when every version the content names — its main library
  in `h5p.json` and every nested `{ library, params }` in `content.json` —
  that is not installed has a newer installed version of the same library
  (the `missingLibraries` rule above), the package is stored as it is: its
  `h5p.json` and `content.json` unchanged and every `content/` file under
  its own name, in the same transaction as any import (`If-Match`,
  `X-Max-Delta-Bytes`, `Idempotency-Key`, a signed `deltaBytes`; a
  replacement removes the stored files the package does not have). The
  answer has the usual shape, `metadata` being the package's `h5p.json`.
  Opened in the editor, such content gets the upgrade dialog above, and the
  author's save after the upgrade stores it on the installed versions. Until
  then it is stored on versions the host does not have: its player page
  fails (`500`) and its download answers `404`, as for any content left
  behind by a library update. Versions only `h5p.json` declares (dependencies of the
  named ones where the package was made) do not count: content naming only
  installed versions is imported the usual way, and its dependencies are
  recomputed from the installed libraries. Refusals: a named version without
  a newer installed one — `422 library-missing`, the message listing those
  versions; a referenced media file the package lacks — `422 media-missing`;
  a `content/` file whose name starts with `.` or `_` (other than
  `.DS_Store`), a file name holding `#`, `?`, `%` or a control character, a
  path of 255 characters or more, a reference to `content.json`/`h5p.json`
  or to a `#tmp` file — `400`; an exam package (below) on a missing version —
  `422 exam-library-missing`, as without the header. Without the semantics
  of the missing versions the host cannot tell which fields hold files: a
  `{ path, mime }` object counts as a file reference (HTTP(S) URLs, YouTube
  and legacy video references excepted, as in an ordinary import; a `data:`
  URI is a missing file), and the file must be in the package. The save after
  the upgrade checks the media with the installed semantics (`422
media-missing`) and drops the files the upgraded parameters no longer
  reference. The header is additive (it bumped no `contractVersion`): a host
  without it refuses as before;
- a package whose `content.json` carries a root `vmbExam` (a book published
  with an encrypted exam) is stored whole by both import routes: every file
  of its `content/` under the name it has in the package, including files the
  open parameters never mention, and the `preloadedDependencies` its
  `h5p.json` declares, merged with those the open parameters need. The host
  cannot read the encrypted chapter, so it keeps everything that chapter may
  use. A new version replaces both the files and the dependencies with the new
  package's own. The host decrypts nothing; `vmbExam` is stored as published.
  On top of the usual package checks such an import is refused with `400` for
  a file name holding `#`, `?`, `%` or a control character (the player joins
  names into URLs unencoded), a path of 255 characters or more under
  `content/` (the export would rename it), a `vmbExam.media` path the package
  does not have, a reference to `content.json`/`h5p.json` or to a `#tmp`
  file, and any `content/` file whose name starts with `.` or `_` other than
  `.DS_Store` (h5p-server does not unpack those, and only the ciphertext
  could name them). Every declared library and its whole dependency tree must
  be installed: a missing library named in `h5p.json` is refused with `400`
  as for any package, a missing or unreadable one further down the tree with
  `422 exam-library-missing`. A library the exam adds in another version
  than the open part uses, also further down either tree
  (`H5P.newRunnable` cannot tell them apart), is refused with
  `422 exam-library-conflict`; two versions within the open part alone, or
  within what the exam adds alone, are accepted as in any book
  (`H5P.AdvancedBlanks 1.2` and `H5P.MultiChoice 1.16` need `H5P.Question`
  1.4 and 1.5). Both codes mean "re-publish the exam book".
  The whole `content/` counts towards `X-Max-Delta-Bytes` and the reported
  byte delta, files the open part does not mention included, and the package
  must fit `EDITOR_MAX_UPLOAD_BYTES` as a whole — libraries and open media
  included; a backend's own limit on exam media does not ensure that. An
  editor save of such a book keeps its files and its stored dependencies (and
  is refused with the same `422` codes when they no longer resolve). The
  editor's "Upload" tab imports any package the usual way, which keeps only
  what the open part references, so an exam book is imported through the
  import routes only: an editor save (or `POST /api/v1/generated-content`)
  whose `vmbExam` is not the one stored with the content is refused with
  `422 exam-import-required`, and an editor save of exam content whose
  `vmbExam.media` files are not all stored with it (as an older host may
  have imported it) with `422 exam-media-missing`. A version without
  `vmbExam` over an exam book is an ordinary import: dependencies are
  recomputed, and the old exam's files stay as unreferenced files;
- every save and import writes the book id in its canonical form and
  answers it as `bookId` (see "Book id" below);
- a save the host refused posts `error` with the HTTP `status` it answered
  (`409` for content changed elsewhere, when Shelf should offer a reload
  before the next save) and, when the host's error body named one, its
  `code` (`422 exam-import-required`, `exam-media-missing`,
  `author-comments-too-long`, `media-missing`, …). Both are optional and
  additive (they bumped no `contractVersion`): a transport failure, a timed-out
  request or an unreadable `2xx` carries the `message` alone, and a load
  failure keeps its `revision`/`code` as described above;
- `ready` and `saved` DTOs include the revision loaded or saved by the editor
  (`ready` for `new` content has none: nothing is stored until the first
  `saved`) and, since contract version 10, the `bookId` of that same
  revision (`null` for `new` content and for content with no valid id), so
  Shelf can send the id to its catalogue and the revision as `If-Match` of
  the publication that follows without the two coming from different
  saves. A caller can pin `GET /api/v1/content/:contentId/download` to that
  revision with `If-Match`: the host checks it under the same shared lock as
  the export and answers `412 ContentRevisionMismatch` before exporting if it
  changed. `If-Match` carries the bare revision, optionally quoted; the host
  issues no ETags, so `W/` validators and `*` are not understood;
- an `X-Request-Id` Shelf forwards is carried by every log line of that
  request and echoed on the response, so one browser action can be followed
  through both the host's and Shelf's logs.

Logs are JSON lines (pino). A request answered with an error is logged at
`error` only when the host failed (5xx); a refusal (4xx) is a `warn`, and a
client that hung up before its request completed — a truncated upload or
save body, a download cancelled mid-stream — is an `info` line ("Editor
service request abandoned by the client"), so alerting on `error` catches the
host's own failures alone. On `SIGTERM`/`SIGINT` the host stops accepting
connections, lets in-flight requests finish (`H5P_HOST_SHUTDOWN_GRACE_MS`,
20 s by default) and exits.

### Book id

A book keeps its identity across versions as a book id: an `@id=<uuid>;`
declaration in `h5p.json`'s `authorComments`. It is what Shelf compares
before importing a package over a stored book, what its catalogue stores the
book under, and what a reader of the package recognises the book by. Every
party parses it the same way (`src/book-id.ts`; the cases are pinned by
`test/fixtures/book-id-fixture.json`, which the other implementations copy):

- a declaration is `id=<value>;`, optionally `@id`, case-insensitive, with
  spaces allowed around `=` and before `;` (an empty value, `@id=;`, is a
  declaration too), at the start of the text or after
  whitespace or a `;` (`x@id=…;` and `guid=…;` are none); the `;` is
  required. All declarations are collected, `@id=A;@id=B;` included;
- the result is **missing** (no declaration), **invalid** (several
  declarations — even equal ones —, a value that is not a UUID in
  `8-4-4-4-12`
  form, or the zero UUID) or **valid** (exactly one UUID, lower-cased).
  `bookId` in every answer and DTO is the valid id or `null` — in the
  listing, the metadata route, the edit model (`GET …/edit`, beside its
  `revision`), the `ready`/`saved` DTOs and every save, import and book-id
  answer.

Every save and import writes the id in its **canonical form**,
`@id=<lower-case uuid>;` on a line of its own, so older readers that miss
`id=…;`, keep the case or read `@id=<uuid>;@popup=true;` as one value find
it too. What a write does with the id:

- an editor save (`PATCH /api/v1/content/:contentId`) and
  `POST /api/v1/generated-content` keep the payload's id (canonicalised); a
  payload that names none keeps the stored book's valid id (the editor form
  holds the metadata it was opened with), and otherwise gets a fresh one,
  appended after the author's text — new content and a stored book without
  a valid id alike. An invalid declaration is saved as it is: the save cannot
  tell which book was meant, and Shelf offers to regenerate it;
- the import routes take `X-Book-Id: keep | new | <uuid>` (absent = `keep`;
  any other value is refused with `400 invalid-book-id`): `keep` writes the
  package's id canonical, gives a package without one a fresh one — over a
  stored book, that book's valid id, so a new version stays the same book —
  and stores an invalid one as it is (over a stored book too); `new`
  replaces the package's id with a fresh one — over a stored book as well:
  the import is then a new book — and a UUID with that one (aligning a
  package with a catalogue book). A replacement takes the first
  declaration's place; further ones are removed. The header is part of the
  operation: an `Idempotency-Key` replayed with another `X-Book-Id` value is
  refused with `409 operation-id-reused`. Absent and `keep` are the same
  value, so an import a version 9 host completed still replays its recorded
  answer — one without a `bookId` field, which version 9 did not answer. So
  does a retry of such an import (the same file, key, target and `If-Match`)
  that an upgraded Shelf sends with a UUID, as long as both the `metadata`
  that import recorded and the content now stored under its `contentId`
  declare that very id: a version 9 import kept the package's own id, so the
  recorded write is the one being retried, and it is answered without
  writing again. Any other UUID, an id changed or content deleted since, and
  `new` stay `409 operation-id-reused`. A package stored with
  `X-Import-Outdated-Libraries: keep` changes in its book id alone;
- `POST /api/v1/content/:contentId/book-id` with the JSON body
  `{ "bookId": "new" }` or `{ "bookId": "<uuid>" }` sets the id of a stored
  content (anything else, `"keep"` included, is `400 invalid-book-id`;
  `404` for an unknown id, `400` for one that is not numeric). It is a
  mutation like a save — `Idempotency-Key`, `If-Match` (`409` on a stale
  revision), `X-Max-Delta-Bytes` — and answers `{ contentId, operationId,
savedBytes, deltaBytes, revision, bookId }`; a replay answers the id drawn
  the first time. Only `authorComments` changes; setting the id a book
  already has in canonical form writes nothing and answers the same
  revision. The editor frame keeps the metadata it was opened with, so Shelf
  reloads it after this call.

The id is drawn inside the content transaction, so a replay of the same
`Idempotency-Key` answers the recorded result instead of drawing another.
Author comments too long to hold the id as well (h5p-server allows 5000
characters) refuse the write with `422 author-comments-too-long` and store
nothing, so a book never loses its id to a save.

### The player page and pick mode

`GET /api/v1/content/:contentId/render` is a standalone H5P player page. Shelf
opens it top-level as a preview. An embedder may instead frame it and let the
user pick an element of the content — the page then reports which
sub-content was clicked. Framed, a VMB.InteractiveBook also takes commands
from the parent over its own bridge (see "Book remote control" below). These
channels belong to the player page alone and do not change
`contractVersion`: an embedder that does not use them sees the page as
before, apart from the book's extra messages to a framing parent.

- `?parentOrigin=<origin>` names the framing page, the only target the player
  posts to and the only origin it accepts messages from. It defaults to the
  page's own origin (the same-origin proxied deployment). With
  `H5P_HOST_ALLOWED_PARENTS` set, a value outside that list, one that does
  not parse or a repeated parameter is refused with
  `400 Parent origin is not allowed.`, as for the editor page; without the
  parameter the page opens as before.
- The page loads `web/player-bridge.js` after the libraries. The bridge stays
  inert unless the page is framed or opened with `?pickMode=1`. The latter
  turns pick mode on locally for a manual check and posts nothing when the
  page is top-level.
- While active, it tags the container each sub-content is attached to with
  `data-sub-content-id` and `data-sub-content-library` (the machine name). The
  tag goes on the container the library attaches into, not on the
  sub-content's own root; an outer tag is never overwritten.
- Framed, it also passes window resizes on to the content (the core only does
  that top-level or for a parent running h5p-resizer).

Messages carry `source: 'editor-embedder'` inbound and
`source: 'h5p-player-host'` outbound. The core's own `{ context: 'h5p' }`
messages travel on the same channel and are not part of this contract.

| Direction | DTO                                                             | Meaning                                                                                                                                                                                                                                                                                                                                                |
| --------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| out       | `{ type: 'player-ready', contentId }`                           | Sent once, when the content has initialized.                                                                                                                                                                                                                                                                                                           |
| out       | `{ type: 'player-error', contentId }`                           | Document ready passed and the content did not initialize. If the page itself failed to load, neither message comes, so wait with a timeout.                                                                                                                                                                                                            |
| in        | `{ type: 'pick-mode', enabled, selectable? }`                   | Turns pick mode on (`enabled: true`) or off; each message replaces the previous state, and turning it off clears the frame. `selectable` lists the ids the embedder can act on (compared case-insensitively); without it any tagged element is pickable, and an empty list makes nothing pickable. Accepted at any time; send it after `player-ready`. |
| in        | `{ type: 'pick-clear' }`                                        | Removes the frame from the picked element.                                                                                                                                                                                                                                                                                                             |
| out       | `{ type: 'picked', contentId, subContentId, library, path }`    | A click picked `subContentId`, the innermost tagged ancestor of the click target that is in `selectable`. `path` lists the ids of all tagged ancestors, innermost first, so the enclosing chapter can be found when a book holds copies sharing an id.                                                                                                 |
| in        | `{ type: 'exam-cipher', requestId? }`                           | Asks for the book's encrypted exam as this page holds it.                                                                                                                                                                                                                                                                                              |
| out       | `{ type: 'exam-cipher', contentId, requestId, vmbExam, files }` | `vmbExam` exactly as in the content's parameters; `files` holds `{ path, data }` for every path of `vmbExam.media`, in its order, `data` being the stored ciphertext as a transferred `ArrayBuffer` (an empty list for an exam without `media`). Requests made while a download runs share it; nothing is kept afterwards.                             |
| out       | `{ type: 'exam-cipher-progress', contentId, requestId }`        | The set is downloading: headers, body bytes or a whole file arrived. Sent to every waiting request, at most every 5 s while that goes on, so a parent can keep waiting for a large set; ignoring it is fine. A parent that waits for it should allow more than 65 s between two (the 60 s idle timeout plus the 5 s interval).                         |
| out       | `{ type: 'exam-cipher-error', contentId, requestId, reason }`   | `no-exam` (the content is no VMB.InteractiveBook with a `vmbExam`) or `fetch-failed` (a file went 60 s without progress — no headers, or no new bytes of its body — or answered an error; no partial answer). Files download three at a time; a waiting file has no clock running.                                                                     |
| in        | `{ type: 'exam-media', requestId?, files }`                     | The decrypted exam media: `files` holds `{ path, data, type? }`, `data` an `ArrayBuffer` (send it as transferable), `type` the file's MIME type (otherwise guessed from the extension). The paths must be exactly those of `vmbExam.media` — same spelling and case, each once, all of them. A valid set replaces the previous one as a whole.         |
| out       | `{ type: 'exam-media-ready', contentId, requestId, count }`     | The set is in place: from now on `H5P.getPath` resolves each of those paths of this content to a `blob:` URL of the plain bytes. Send `injectExam` only after this.                                                                                                                                                                                    |
| out       | `{ type: 'exam-media-error', contentId, requestId, reason }`    | Nothing changed. `reason`: `unknown-path` (a path not in `vmbExam.media`), `incomplete`, `duplicate`, `bad-data` (`data` not an `ArrayBuffer`, `files` not a list) or `no-exam`.                                                                                                                                                                       |

In pick mode, a click inside tagged content is swallowed. If it has a
selectable ancestor, that element gets a yellow outline and `picked` is
posted; otherwise nothing happens. A click outside tagged content — the
book's navigation, table of contents and cover button — works as usual.
Presses and touches inside tagged content are stopped, so drags, swipes and
custom controls do not start; scrolling stays native and a tap still picks.
Embedded `iframe`/`video`/`audio` elements stop taking pointer events, so a
click on them picks their container. Keyboard input is not intercepted.

#### Book remote control

VMB.InteractiveBook has a postMessage bridge of its own (protocol `vmb-host`
in, `vmb-book` out, `protocol: 1`; its commands — `goToPage`, `next`,
`previous`, `getState`, `highlight`, `clearHighlight`, `injectExam`,
`lockExam`, `getExamState`, `ping` — and events are specified in the book's
`EXAM_BRIDGE_CONTRACT.md`). The book takes commands only from, and posts
events only to, the origins in its `behaviour.remoteOrigins`, by default its
own. On the framed page the bridge therefore adds `parentOrigin` to that list
before the content starts — and this page's own origin first when the
authored list holds no usable origin, since a non-empty list replaces the
book's default. The authored entries stay as they are. The parent then talks
to the book directly, with `bookId` set to the `contentId` of `player-ready`.

- `source: 'vmb-book'` messages are not part of this host's contract. The host
  neither checks nor relays `vmb-host` commands; the book checks the sender's
  origin and that it is an ancestor of the frame.
- A book with `behaviour.enableRemoteControl: false` and no exam starts no
  bridge of its own: `player-ready` still arrives, `vmb-book` messages do
  not. A parent should therefore wait for the book's answer to `ping` with a
  timeout of its own. A book carrying an exam always starts its bridge.
- Top-level (Shelf's preview) nothing changes; a parent that does not speak
  `vmb-host` receives extra `{ source: 'vmb-book' }` messages and ignores
  them like the core's `{ context: 'h5p' }` ones.
- The host decrypts nothing. `vmbExam` stays in the parameters as published;
  the parent passes the decrypted chapter to the book with `injectExam`. The
  book cannot move files, so the exam's own media travel through the
  player-host channel above: `exam-cipher` (ciphertext from the copy shown;
  `exam-cipher-progress` while it downloads) → decryption in the parent →
  `exam-media` → `exam-media-ready` → `injectExam`. The blob URLs live until
  the page unloads; a replaced set's URLs are not revoked earlier, since
  library instances may still hold them.
- The substitution happens in `H5P.getPath` only. A library that builds a
  file URL itself bypasses it, and so does one that resolves relative links
  against the address of a file it loaded: `VMB.SyncLesson` 1.4 loads an HTML
  file from the content, and if that file is exam media, its address is a
  `blob:` URL against which `./x` links to neighbouring files do not
  resolve. The standard media libraries go through `H5P.getPath`.
- Every answer to `exam-cipher` and `exam-media` echoes the request's
  `requestId`, or carries `requestId: null` when the request had none.

### Raw content archives (VMB.SyncLesson)

`VMB.SyncLesson` and `VMB.EduDict` keep their sources in a zip stored as one
content file under an extension the H5P whitelist allows (`{ vmbraw: { path:
"file-x.docx" } }` in the parameters) and load its entries through
`H5P.getPath("file-x/<entry>")`: a folder named after the archive without its
last extension, next to `content.json`. The CyberShelf viewer unpacks that
folder when it installs a book; this host serves it from the archive
(`src/raw-archives.ts`):

- A `GET`/`HEAD` of `/h5p/content/:id/<folder>/<entry>` that names no stored
  file of the content, under the folder of an archive its parameters name
  (`vmbraw.path` anywhere in `content.json`), is answered from that archive.
  The archive is unpacked on the first such request into
  `tenants/<distributorId>/raw-archives/<contentId>/`, keyed by the archive's
  content, and served from there with the headers of any content file
  (sandbox CSP, `attachment` for documents, `Cache-Control: private,
no-store`) and Range support. A stored file of the same path always wins.
- Unpacked are entries whose extension the content whitelist allows, plus
  `html`, `htm` and `css`, which the libraries load as articles and styles.
  Scripts, dotfiles, `__MACOSX/` and names with `%` or `\` are left out and
  answer 404 (`H5P.getPath` does not encode a path, so a name with `%` could
  not be requested anyway).
- The first request after the archive file appears on disk reads it whole
  once to hash it, then unpacks it: for a large archive that request (a
  lesson's first file) waits that long; the requests behind it share the
  work.
- An archive that is not a zip, names an entry outside its folder, holds more
  than `H5P_HOST_RAW_ARCHIVE_MAX_ENTRIES` entries (default 10000) or unpacks
  to more than `H5P_HOST_RAW_ARCHIVE_MAX_BYTES` (default 1 GiB) unpacks
  nothing: its files answer 404, the library shows its own error, the rest of
  the content plays, and the log carries a warning. It is not read again
  until the process restarts or the archive changes.
- The folder is derived data, outside the content: not in its revision,
  journal, export or byte accounting. Deleting it is always safe; it is
  unpacked again on demand. A save that keeps the archive keeps its folder
  (after one read of the archive per process where the save copied it rather
  than hardlinked it); a replaced archive is unpacked anew and its old folder
  removed; deleting the content removes them all. A file system error while
  unpacking answers 500 and is not remembered as a broken archive.
- The player page loads `web/vmb-environment.js` after the libraries: on a
  page that loaded `VMB.SyncLesson` it defines an empty `window.ActivePackage`,
  the viewer global that library waits for before it starts (it calls nothing
  on it). `VMB.Adapt` has checked the same global by then and set up its
  H5P-server mode; `VMB.isBookRT` stays unset. `VMB.EduDict` on the same page
  then names the viewer in the text of its load errors, its only use of the
  global.
- Only the open parameters are read: an archive inside an encrypted exam
  chapter is not served.

The route set is unchanged (`/h5p/content/:id/*` already served content
files), so `contractVersion` stays.

## Runtime assets and libraries

The H5P **editor runtime** is tracked in this repository: `assets/h5p/core`,
`assets/h5p/editor` and the CKEditor it bundles (`assets/h5p/editor/ckeditor`),
alongside that CKEditor build's own source inputs in `sources/ckeditor5`.
h5p-express serves these under `?version=<h5pVersion>` with `max-age` set to
one year, so a browser that has already fetched a file keeps that answer
until the query string changes. **Any change under `assets/h5p/{core,editor}`
must bump this package's own `version` in `package.json`** — `h5pVersion`
(`src/h5p/config.ts`) is `1.28-<package version>`, so a release bump is what
actually busts the cache; editing the assets alone does not.

H5P **library packages** (content types and editor widgets) are provisioned
separately into `.host-data/libraries` (git-ignored). These packages contain
third-party code and resources under their respective licenses. Review each
distributed package and preserve its notices and corresponding source where
required; excluding a directory from Git does not change those obligations.

```bash
H5P_LIBRARY_SOURCE_DIR=/path/to/library/bundle npm run provision:libraries
```

The source is a mounted volume or an unpacked release artifact; a CI/deploy step
fetches it before running the command. For a reproducible deployment — and for
a legal sign-off that names one fixed library set — build a **versioned
bundle** instead and install from it:

```bash
# on the machine that holds the vetted set
npm run bundle:libraries -- --version 2026.09 --out dist
#   → dist/h5p-libraries-2026.09.tar.gz + .sha256 (manifest and license
#     inventory inside the archive)

# on the server
H5P_LIBRARY_SOURCE_BUNDLE=/srv/bundles/h5p-libraries-2026.09.tar.gz npm run provision:libraries
```

The install verifies the checksum (the `.sha256` sidecar, or
`H5P_LIBRARY_SOURCE_SHA256`), checks the manifest against the archive and
records the version in `.bundle.json` beside the libraries; `GET /ready`
then reports it as `bundle`. The script strips macOS metadata (`._*`
AppleDouble twins, `.DS_Store`, `__MACOSX`) from the copies and from the target,
and fails while any other entry named like a library is not a library
directory: h5p-server lists libraries by entry name, and one such stray entry
crashes its content-type listing. Without `H5P_LIBRARY_SOURCE_DIR` the command
only checks (and cleans) the target. `npm run licenses` regenerates
`THIRD-PARTY-LIBRARIES.md` from whatever is provisioned. Recognized H5P license
codes and common SPDX ids establish coverage; a non-empty field alone does
not. Missing declarations are resolved through the hand-curated
`scripts/library-license-evidence.json` (upstream license text, holder, URL,
check date) and otherwise reported as `(none)`. `cr` (the library.json code
for copyright), `C`, `U` and unknown labels remain coverage gaps. A
public-domain marker (`pd`, `PD`, `CC PDM`) is a dedication rather than a
license text, so it requires recognized upstream evidence, as recorded for
H5P.TextUtilities and H5P.Timer (WTFPL).

That evidence file is tracked and deployment-independent, while the library
set is neither, so the run names on stderr where the two fail to meet: a
provisioned library with no recognized declaration, applicable evidence or
reviewed exception (its terms are unrecorded — read the upstream text and add
one, or drop the library), and an entry or reviewed exception it used whose
`checked` date is older than `LICENSE_EVIDENCE_MAX_AGE_DAYS` (default 365, `0`
disables). Both are
warnings and the inventory is written either way. Add `--strict`
(`npm run licenses -- --strict`, or `LICENSE_INVENTORY_STRICT=1`) to exit
non-zero on an unrecorded library. `npm run bundle:libraries` always enables
strict mode and forwards these warnings; a coverage gap stops it before an
archive is written.

The evidence file also records `reviewedExceptions`, approved by the maintainer
for H5PEditor.MultiLineSelect 1.0.9, H5PEditor.MultiMediaChoice 1.0.0,
VMB.Adapt 1.0.2, VMB.InteractiveBook 1.6.10 and VMB.InteractiveBook 1.7.3.
Each exception matches the major/minor directory, patch version and declared
license, and appears in a separate report section. It permits that entry
through the strict gate without claiming a license grant; the bundled-copyleft
scan still runs. A changed version or declaration needs a new review.

An existing library must match the bundle's files to be kept. A mismatch fails
before installing anything; use `--force` to replace it, or provision a new
empty directory. A replacement — from a bundle or a directory, always
under `--force` — keeps the `Name-major.minor` directory, so no content
upgrade follows it: before anything is written the run compares every
`type: "library"` field of each installed copy's `semantics.json` with the
new copy's and refuses when an option was dropped or re-versioned
(`"H5P.MultiChoice 1.16"` → `"1.17"`), a field disappeared or its value
moved (any change of where it is stored, e.g. a single-field group, which
stores its field's value directly, got a second field, or a group became a
list), or a `semantics.json` cannot be read, naming the library, field and
option. Added options pass. `--force` alone never overrides this; re-run
with `--force --allow-dropped-options` to replace such a library anyway (the
flag alone changes nothing and says so). The host then opens content
holding a nested version its field no longer lists only through its
upgrade offer (see `missingLibraries` above); it cannot find a
value left under a removed or moved field, so check and migrate such content
before overriding that. Prefer shipping such a change as a new minor
version, which the content upgrade handles. A corrupt installed copy is
repaired without the comparison.

Extra libraries outside the bundle cause a refusal even with
`--force`, since saved content may still need them. Install a different library
set into a new `H5P_LIBRARIES_DIR` and restart the host after checking content
compatibility. Bundle identity is written only after the installed files match;
a failed replacement clears the old identity. Provision with the host stopped.

## Development

```bash
npm install
npm run build
npm run provision:libraries            # once H5P_LIBRARY_SOURCE_DIR is set
H5P_HOST_SHARED_SECRET=dev-secret npm start
```

Dependency installation must run lifecycle scripts: `postinstall` runs
`scripts/patch-image-size.mjs`, which applies the local `image-size` security
fix, including for production installs with `npm ci --omit=dev`. Copy
`scripts/` alongside `package.json` and `package-lock.json` before installing
in a deployment image. The host refuses to start on an unpatched copy, so an
install with `--ignore-scripts` fails at startup instead of running exposed.
`npm audit` still flags the published `image-size` version because it cannot
see the local fix; `npm run audit:ci` (used in CI) allows exactly those two
advisories, with a review date, and fails on any other high or critical one.

Defaults:

- listen address: `127.0.0.1:8090`;
- route prefix: `/h5p-editor-core`
  (`H5P_HOST_ROUTE_PREFIX` to override);
- data: `.host-data`, holding `tenants/<distributorId>/` (one directory per
  distributor: its `content`, its `operations` journal, its `locks` and the
  unpacked `raw-archives`),
  `libraries/` and `upload-tmp/`;
- runtime libraries: `.host-data/libraries` (`H5P_LIBRARIES_DIR` to override).

Copy `.env.example` to `.env` for the full list of settings and their defaults.

## Configuration and operations

Set `H5P_HOST_SHARED_SECRET` to a long random secret shared with Shelf. Startup
requires it for every `NODE_ENV` value, including unset, except explicit
`NODE_ENV=development`, which allows the local `dev-secret` fallback. The
secret must be printable ASCII without spaces (`!`–`~`): it travels as the
`X-H5P-Host-Secret` header value, which cannot carry a non-Latin-1 character
(Node refuses to send such a header, so Shelf's request never leaves) and
loses surrounding spaces in transit (the host then answers `401`), so such a
secret would fail every request instead of failing the start. The rule is
deliberately simpler than that limit (it excludes inner spaces and other
control characters too); a value outside it stops startup with the rule named.

`H5P_HOST_ALLOWED_PARENTS` is a comma-separated list of HTTP(S) URLs without
wildcard hosts. The host normalizes and deduplicates their origins for both
`frame-ancestors` and the postMessage allowlist reported as `allowedParents`
in `/ready`. Any other entry (a bare host, a wildcard, another scheme) stops
the start with the entry named: dropping it would leave the allowlist empty,
and an empty allowlist means the same-origin deployment, where every
`parentOrigin` is accepted. Use explicit origins for a deployment framed
across origins.

Every response carries `Content-Security-Policy: frame-ancestors <allowlist>;
base-uri 'self'; object-src 'none'` (user-supplied files get a stricter
sandbox policy instead). A proxy that adds a policy of its own must leave
`base-uri` at least as open as `'self'`: the browser enforces both policies,
and the core's jQuery sets a same-origin `<base href>` while parsing HTML
(see [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md)).

Every numeric setting is read once, before the port opens, and a value that is
not a number (or not a whole one, where a count is expected) stops the start
with the variable's name. An unset or blank variable takes the documented
default; a typo is never silently replaced by one.

Tenant editors are cached separately from pending initialization:
`H5P_HOST_TENANT_CACHE_MAX` defaults to 100 completed editors and
`H5P_HOST_TENANT_INIT_MAX` to 16 simultaneous constructions. Excess new-tenant
requests receive `503` and may be retried; cached tenants remain available.
Cache eviction never removes saved content.

One tenant is written by one process at a time. The in-memory queue orders
this process's own requests; a lock file under `tenants/<id>/locks` orders it
against every other process on the same data directory. Writers exclude
everybody, readers of more than one file share with each other, and a holder
keeps its lock file's mtime fresh while it works.

The lock owner is written and closed in a private `.claim-*` file before a
hard link publishes it at the lock's path. A competing claim cannot overwrite
that path, and an I/O failure only cleans up its own private file. The data
filesystem must support hard links: the host probes the tenant directory at
start and refuses to run on a mount that has none. The journal sweep also
removes abandoned claim files; deleting one never removes a published lock's
other link, and a claim that was only paused finds its file gone and starts
over.

A holder that dies leaves its file behind. For an owner on this machine the
answer is its process: gone means the lock is free at once, and _still there_
means the lock is honoured however old it is — a process that has been stopped,
swapped out or is simply slow is still holding the tenant, and taking its lock
would put two writers in one directory. The cost of that strictness is a tenant
answering 503 until someone deals with a stuck process, which is the failure
worth having. `H5P_HOST_LOCK_STALE_MS` (default 60 s without a heartbeat) is
the fallback for an owner on another machine, where a pid says nothing, and
`H5P_HOST_LOCK_MAX_HOLD_MS` (default 1 h) is the ceiling on the pid rule
itself: a pid is not an identity, and a machine that returns with the same
hostname and the same number on an unrelated process would otherwise leave a
lock nothing could ever take.

"This machine" means "the same hostname", and pids are compared within it, so
every process namespace sharing the data directory needs a hostname of its
own. Containers that share a volume must not be given the same explicit
hostname; Docker's default, the container id, is unique.

Between machines a lock's age is the only evidence, measured as the judging
host's clock minus the mtime the owner's heartbeat wrote. So every machine
sharing the data directory needs a clock that agrees with the others to well
within `H5P_HOST_LOCK_STALE_MS` (run NTP), and the mount has to show a
refreshed mtime within one heartbeat, a third of that window — on NFS, an
attribute cache (`actimeo`, `acregmax`) shorter than that. Otherwise a live
holder looks abandoned. A writer is still kept out by the pin (below), but a
reader's lock is taken from it, and a save can then publish under a read that
spans two files.

A writer that loses its lock while it is running — an hour of silence, or a
file somebody deleted — is refused before it writes a journal record and again
before it publishes one, and answers 503 (`content-lock-lost`). Each check
reads the current owner from disk; it does not wait for a heartbeat.

An additional `locks/content.pin` holds the tenant until the writer's entire
task ends, including staging and cleanup. Replacing an expired lock does not
let a second process enter while the old writer could still resume. The pin
is reclaimed automatically — and the tenant's journal replayed — when its
recorded owner is on this machine and is proven gone: its pid has exited; it
names this process's own pid (a restarted container is pid 1 again) with a
token this process never issued; or, on Linux, the machine has booted since,
or the pid now belongs to a process that started at another time. An old pin
that names no owner at all, left by an older host or a storage crash, is removed
once it is older than a few seconds. Current hosts publish a complete identity
atomically; an older host must be stopped before upgrading, since its empty
pin could still belong to a paused claim. The periodic journal sweep does the
same for tenants nobody is using.

An owner on another machine, or a pid that is alive and cannot be told apart
from the owner (off Linux, or a pin written by an older version), cannot be
proven dead: reads and writes then answer 503 (`content-locked`). Neither lock
age limit overrides this rule. To recover such a tenant:

1. stop every host process that shares the data directory;
2. read `<tenant>/locks/content.pin` — it names the owner's `hostname` and
   `pid` — and make sure that process is gone or can no longer reach the
   storage;
3. delete the pin and create an empty `<tenant>/locks/recovery-required`, so
   the next request replays the tenant's journal before it reads;
4. start the host.

Do not remove a pin while its owner can still access the storage. All
processes sharing the directory must run this protocol; stop older versions
before upgrading to it.

The host flushes staged file data and directory entries before preparing the
journal, then flushes the publication renames before recording `done`. Real
I/O errors fail the write and leave any prepared transaction for recovery.
On platforms that do not support directory fsync, that part of the durability
guarantee remains limited by the filesystem.

Taking a lock from a dead owner is also treated as evidence that its
publication may be half-applied: a flag is left in the tenant's `locks`
directory and the journal is replayed before anything reads it. A publication
that fails outright raises the same flag, so the repair is owed even if the
process that owed it is gone. `H5P_HOST_JOURNAL_SWEEP_INTERVAL_MS` (default 6 h) is how often
settled receipts and abandoned lock files are swept for tenants that have gone
quiet, and `H5P_HOST_RECOVERY_WAIT_MS` (default 5 s) how long a start waits for
a tenant another live process is holding before it leaves that tenant's journal
to it.

`H5P_HOST_MAX_TEMP_BYTES` defaults to 1 GiB per tenant (`0` disables it).
Editor uploads, API temporary-file uploads and imports count incoming bytes
and reserve space for concurrent requests, admitted first come, first served.
The reservations live in each host process's memory: several processes
accepting uploads for one tenant on a shared data directory do not see each
other's requests in flight, so together they can stage more than the cap.
This is a per-tenant burst guard, not a hard disk quota: multipart data reaches
the shared staging directory before the check, and archive expansion or H5P
metadata can add bytes afterwards, so provision disk for the aggregate across
tenants and monitor it. Two request-level limits sit above it:
`H5P_HOST_MAX_MULTIPART_BYTES` refuses an over-large request from its
Content-Length before anything is staged, and `H5P_HOST_MAX_UPLOAD_FILES` caps
how many files one request may carry.

Temporary uploads expire even while an editor tab is open. A save that loses
a referenced local media file (expiry or a copy failure) answers 422 with
`media-missing` and publishes no changes. Re-upload the file and retry; media
already present in saved content can be reused after its temporary copy expires.

Content listings take the shared content lock, so a save cannot temporarily
remove an item from the list. Export through
`GET /api/v1/content/:id/download`; the vendor `/h5p/download/:id` route is
disabled because it cannot build a consistent snapshot under that lock.

## Deployment notes

The host is not intended to be exposed directly to the internet. Put it behind
an authenticated reverse proxy (Shelf), and give the proxy its own request-body
limit: the Content-Length guard cannot measure a chunked upload that sends no
length.

A deployment needs more than `build/`: `web/` and `assets/` are served to the
browser, and `COPYING`, `docs/CKEDITOR_SOURCE.md` and `sources/` are what the
`/licenses` page links to as corresponding source. Those routes answer 404 with
an explanation when a file is missing, so a stripped-down image shows up as a
broken obligation rather than a stack trace.

The content lock holds between processes as well as inside one, so a second
host started on the same data volume — a rolling restart whose old process has
not exited, a stray unit, an operator's script — waits its turn rather than
publishing over a save in flight. A failed publication is recovered under that
lock before the next content read or mutation, including when the process that
failed was a different one. If recovery still fails, queued work is refused
until it can succeed. User-supplied files have a sandbox CSP, including partial responses;
HTML and other documents are downloads, and the temporary upload API rejects
HTML and scripts. SVG can still be used as an image.

## Licenses page

The exact CKEditor build source, dependency commits and verified rebuild
commands are in [CKEDITOR_SOURCE.md](CKEDITOR_SOURCE.md). The custom build
inputs are preserved in `sources/ckeditor5/`. `npm run verify:ckeditor` checks
their hashes and all 73 shipped runtime files against the pinned upstream
snapshot; the normal test suite includes this check.

`GET <prefix>/licenses` serves `THIRD-PARTY-NOTICES.md` as an HTML page (the
Markdown source with `?format=md`), linked from the editor page. It describes
the browser components and their source locations, including the exact
CKEditor build inputs — the CKEditor 5 bundle in particular is minified object
code under the GPL, so that pointer is an obligation, not a courtesy. When
upgrading the H5P runtime or CKEditor, update the versions there;
`test/licenses.test.js` checks that the notices match the bundled CKEditor
version, the pinned H5P core version and the installed h5p-server.
