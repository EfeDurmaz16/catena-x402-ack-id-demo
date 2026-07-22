# Review notebook: rebuild and redeploy

The page-by-page review notebook at https://v1.efebarandurmaz.com is generated
from this repo, not hand-edited. Rebuild it whenever the code changes so its
deep links and diff blocks stay in sync with HEAD.

## Source

- `gen_pages.py` writes `pages.json` (the seven review pages).
- The pr-flow builder embeds every file's diff behind the pages and wires the
  `jumpTo(path, line)` deep links. `index.html`, `pages.json` and the vendored
  `mermaid.min.js` are build outputs and stay gitignored.

## Rebuild against current HEAD

    python3 .pr-review/gen_pages.py
    EMPTY=$(git hash-object -t tree /dev/null)
    python3 ~/.claude/skills/pr-flow/scripts/build_notebook_html.py \
      --pages .pr-review/pages.json --repo . --range "${EMPTY}..HEAD" \
      --title "catena-x402-ack-id-demo reference notebook" \
      --out .pr-review/index.html

The empty-tree range renders every file at HEAD as current content, so the
notebook is a whole-repo review rather than a diff against a base.

## Validate deep links

Every `jumpTo(path, line)` must point at the intended symbol in the current
file. After a rebuild, check each line number against `sed -n "Np" path`. Wrong
line numbers are the most common defect, and they shift on every refactor.

## Deploy

    cp .pr-review/index.html .pr-review/mermaid.min.js <deploy-dir>/
    cd <deploy-dir> && vercel --prod --yes

`mermaid.min.js` is vendored beside `index.html` so diagrams render without a
CDN. The Vercel project `catena-pa1-review` is aliased to v1.efebarandurmaz.com.

## Log

- Initial build: seven pages over the whole repo, deployed to
  v1.efebarandurmaz.com.
- After the settlement-time nonce fix (nonce consumption moved out of the
  identity gate into the x402 `onAfterVerify` hook): page 4 rewritten for
  consume-at-settlement with binding checked first, all deep links re-pointed to
  the new line numbers, all twenty validated against source, redeployed and
  verified live.
