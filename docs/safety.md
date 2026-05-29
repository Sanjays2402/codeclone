# Safety and licensing

CodeClone is a small, opinionated tool. The default mode is the safe one.
This document lists the rules the tool enforces, the rationale for each, and
the knobs to relax or tighten them.

## Author provenance

The whole product hinges on the claim that the training set is *your* code.
The exporter enforces this in two places:

1. The diff walker rejects any commit whose author email is not in
   `Settings.author_email_set()`.
2. The pair writer records a 16-hex-char SHA256 prefix of the author email on
   each pair. We do not write the raw email to disk.

If you contribute via the GitHub web UI noreply pattern
(`<id>+<user>@users.noreply.github.com`), the author filter also accepts pairs
where the noreply user matches a configured GitHub username.

Merge commits and revert commits are skipped by default. The author of a
merge commit is "the merger", not "the author of the underlying work", and
revert commits are duplicative noise.

## License hygiene

Training a model on code with restrictive licenses is a legal hazard. The
filter has three modes:

| Mode | Permissive | Unknown | Copyleft / source-available |
|------|-----------|---------|-----------------------------|
| `strict`            | accepted | rejected | rejected |
| `permissive_only` (default) | accepted | accepted | rejected |
| `off`               | accepted | accepted | accepted |

Permissive set includes MIT, Apache-2.0, BSD-2/3/0, ISC, MPL-2.0, Unlicense,
CC0, Zlib, Python-2.0. Copyleft set includes GPL family, LGPL family, AGPL
family, SSPL, BUSL, Commons-Clause.

If a repo has no top-level `LICENSE` file we treat it as "unknown" and use
the configured mode to decide. `strict` is conservative; `permissive_only`
is pragmatic; `off` is your problem.

This is a defense layer, not legal advice. If you intend to publish or
redistribute the resulting adapter, please verify the licenses of every
upstream repo by hand.

## Secret scrubbing

The exporter drops any line in a diff that matches one of a dozen common
secret patterns: GitHub tokens (classic + fine-grained), OpenAI keys,
Anthropic keys, AWS access keys, JWTs, PEM private key headers, Slack tokens,
Google API keys, and Twilio account SIDs.

It drops *the line*, not the file. A handful of false positives is better
than a real token sitting in a training dataset.

## Base model weights

CodeClone does **not** bundle base model weights. The first time you train
or serve against a real backend, you (the user) initiate a Hugging Face
download. That action, and its license terms, are yours. The default base
(Qwen2.5-Coder family) is Apache-2.0 at time of writing; confirm before
redistributing.

## What CodeClone does NOT promise

- It does not protect against you intentionally lying to the author filter.
  If you configure `AUTHOR_EMAIL=*@*` you will get a fine-tune on whatever
  arrives, and nothing in this repo can stop you.
- It does not detect plagiarism, code attribution drift, or DMCA exposure.
- It does not run the OpenAI moderation pipeline on inputs or outputs. If
  you stand the serve endpoint up in front of untrusted clients, add a layer.

## Reporting an issue

If you find a defect in the safety stack (license detection misses a known
copyleft SPDX, the secret regex misses a token shape, the author filter
accepts a non-author), open an issue and tag it `safety`. These bugs jump
the queue.
