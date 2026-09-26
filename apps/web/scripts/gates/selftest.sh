#!/bin/bash
# A gate is trusted only after it has refused a planted violation.
#
# For every installed gate: run it clean against the committed baseline (must pass), then
# plant one violation in a throwaway copy of the tree (must be refused, exit 1), then take
# away its precondition (must say DID NOT RUN, exit 2). A gate that passes a planted
# violation is blind, and a blind gate reads as a clean bill of health.
#
#   bash scripts/gates/selftest.sh        (from apps/web; needs git and node, nothing else)
set -u
WEB="$(cd "$(dirname "$0")/../.." && pwd)"
REPO="$(cd "$WEB/../.." && pwd)"
G="$WEB/scripts/gates"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
expect() { # expect <code> <label> <command...>
  local want="$1" label="$2"; shift 2
  "$@" > "$TMP/out.txt" 2>&1; local got=$?
  if [ "$got" = "$want" ]; then echo "ok    $label (exit $got)"; pass=$((pass+1));
  else echo "FAIL  $label: wanted exit $want, got $got"; sed 's/^/        /' "$TMP/out.txt" | head -25; fail=$((fail+1)); fi
}

# a pristine copy of apps/web as committed plus the working tree's gate files
fresh_copy() {
  rm -rf "$TMP/web"; mkdir -p "$TMP/web"
  (cd "$WEB" && git ls-files -z --cached --others --exclude-standard . | xargs -0 tar cf - 2>/dev/null) | (cd "$TMP/web" && tar xf -)
}
ratchet() { # ratchet <gate> in the copy against the committed baseline
  (cd "$TMP/web" && node "scripts/gates/check-$1.mjs" --ratchet --baseline "qa/gates/$1.baseline.json")
}

echo "== ratchet gates, clean tree =="
fresh_copy
for g in route-boundaries swallowed-catch server-waterfall hardcoded-hebrew project-shape; do
  expect 0 "$g: clean tree is not worse than its baseline" ratchet "$g"
done
expect 0 "baselines are reproducible from the tree" bash -c "cd '$TMP/web' && node scripts/gates/check-baselines-reproducible.mjs"

echo "== planted violations =="
fresh_copy
mkdir -p "$TMP/web/app/api/planted-rpc"
cat > "$TMP/web/app/api/planted-rpc/route.ts" <<'EOF'
import { createUserClient } from '@/lib/server/supabase/server';
export async function GET() {
  const db = await createUserClient();
  return Response.json(await db.rpc('fn_admin_orders_list', {}));
}
EOF
expect 1 "route-boundaries refuses a route calling .rpc() itself" ratchet route-boundaries
rm -rf "$TMP/web/app/api/planted-rpc"
mkdir -p "$TMP/web/app/api/planted-from"
printf "import { serviceClient } from '@/lib/server/supabase/service';\nexport async function GET() {\n  return Response.json(await serviceClient().from('orders').select('*'));\n}\n" > "$TMP/web/app/api/planted-from/route.ts"
expect 1 "route-boundaries refuses a route calling .from('orders') itself" ratchet route-boundaries
rm -rf "$TMP/web/app/api/planted-from"
mkdir -p "$TMP/web/app/(public)/planted-page"
printf "import { callRpc } from '@/lib/server/supabase/rpc';\nexport default async function Page() {\n  const x = await callRpc(null as never, 'fn_x', {}, null as never);\n  return <p>{String(x)}</p>;\n}\n" > "$TMP/web/app/(public)/planted-page/page.tsx"
expect 1 "route-boundaries refuses a page calling callRpc() itself" ratchet route-boundaries
rm -rf "$TMP/web/app/(public)/planted-page"

printf "import 'server-only';\nexport function planted() {\n  try { return JSON.parse('x'); } catch { return false; }\n}\n" > "$TMP/web/lib/server/capacity/planted.ts"
expect 1 "swallowed-catch refuses catch { return false }" ratchet swallowed-catch
printf "import 'server-only';\nexport function planted() {\n  try { return JSON.parse('x'); } catch (e) {}\n}\n" > "$TMP/web/lib/server/capacity/planted.ts"
expect 1 "swallowed-catch refuses an empty catch" ratchet swallowed-catch
rm -f "$TMP/web/lib/server/capacity/planted.ts"

mkdir -p "$TMP/web/app/(public)/planted-waterfall"
cat > "$TMP/web/app/(public)/planted-waterfall/page.tsx" <<'EOF'
import { getTranslations } from 'next-intl/server';
import { getPublicCatalog } from '@/lib/server/catalog';
export default async function Page() {
  const t = await getTranslations('public');
  const catalog = await getPublicCatalog();
  return <p>{t('title')}{String(catalog)}</p>;
}
EOF
expect 1 "server-waterfall refuses two independent awaits in a page" ratchet server-waterfall
rm -rf "$TMP/web/app/(public)/planted-waterfall"

printf "export function Planted() {\n  return <p>%s</p>;\n}\n" "$(printf '\xd7\xa9\xd7\x9c\xd7\x95\xd7\x9d')" > "$TMP/web/components/Planted.tsx"
expect 1 "hardcoded-hebrew refuses a Hebrew JSX literal" ratchet hardcoded-hebrew
rm -f "$TMP/web/components/Planted.tsx"

printf "export const x = 1;\n" > "$TMP/web/lib/server/capacity/planted-no-guard.ts"
expect 1 "project-shape refuses a lib/server module without server-only" ratchet project-shape
rm -f "$TMP/web/lib/server/capacity/planted-no-guard.ts"

echo "== the reproducibility check refuses a hand edit =="
fresh_copy
node -e "
const f='$TMP/web/qa/gates/swallowed-catch.baseline.json';
const b=JSON.parse(require('fs').readFileSync(f,'utf8'));
b.items['lib/server/auth/admin.ts'].returns_falsy += 1;
require('fs').writeFileSync(f, JSON.stringify(b,null,2));"
expect 1 "a hand-raised count no longer matches a fresh scan" bash -c "cd '$TMP/web' && node scripts/gates/check-baselines-reproducible.mjs"

echo "== DID NOT RUN is its own outcome =="
fresh_copy
rm -f "$TMP/web/qa/gates/route-boundaries.baseline.json"
expect 2 "route-boundaries with its baseline missing" ratchet route-boundaries
expect 2 "route-boundaries with no app/api to scan" bash -c "cd '$TMP' && mkdir -p empty && cd empty && node '$G/check-route-boundaries.mjs' --ratchet --baseline '$WEB/qa/gates/route-boundaries.baseline.json'"

echo "== diff gates (a throwaway git repo shaped like this one) =="
R="$TMP/repo"; mkdir -p "$R/apps/web/lib/server/capacity" "$R/apps/web/app/x" "$R/apps/web/messages" "$R/output/qa"
cd "$R" && git init -q -b develop && git config user.email t@t && git config user.name t
printf '# contract\n' > output/qa/SYSTEM-CONTRACT.md; printf '#!/bin/bash\n' > output/qa/verify-all.sh
printf "import 'server-only';\nexport function computeTotal(a: number) {\n  return a;\n}\n" > apps/web/lib/server/capacity/total.ts
printf "import { computeTotal } from '@/lib/server/capacity/total';\nexport const a = computeTotal(1);\n" > apps/web/app/x/one.ts
printf "import { computeTotal } from '@/lib/server/capacity/total';\nexport const b = computeTotal(2);\n" > apps/web/app/x/two.ts
printf '{\n  "a": "x"\n}\n' > apps/web/messages/he.json
git add -A && git commit -qm base && git checkout -qb feature/x
printf "import 'server-only';\nexport function computeTotal(a: number, vat = 1.18) {\n  return a * vat;\n}\n" > apps/web/lib/server/capacity/total.ts
git commit -qam "behaviour change"
expect 0 "system-contract --exist finds output/qa/SYSTEM-CONTRACT.md" node "$G/check-system-contract.mjs" --exist
expect 1 "system-contract --fresh refuses an apps/web behaviour change with the contract untouched" node "$G/check-system-contract.mjs" --fresh --base develop
printf '# contract\nvat\n' > output/qa/SYSTEM-CONTRACT.md; git commit -qam "contract"
expect 0 "system-contract --fresh passes once the contract is in the same diff" node "$G/check-system-contract.mjs" --fresh --base develop
expect 2 "system-contract --fresh without a base is DID NOT RUN" node "$G/check-system-contract.mjs" --fresh
node "$G/check-caller-count.mjs" --base develop > "$TMP/callers.txt" 2>&1
if grep -q "computeTotal   2 caller(s)" "$TMP/callers.txt"; then echo "ok    caller-count names the 2 callers of a changed function"; pass=$((pass+1));
else echo "FAIL  caller-count did not report 2 callers"; sed 's/^/        /' "$TMP/callers.txt"; fail=$((fail+1)); fi
expect 1 "caller-count --strict 2 refuses when the threshold is met" node "$G/check-caller-count.mjs" --base develop --strict 2
expect 2 "caller-count with no base is DID NOT RUN" node "$G/check-caller-count.mjs"
printf '{\n  "a": "x",\n  "b": "%s: 5"\n}\n' "$(printf '\xd7\xa1\xd7\x94\xd7\x9b\xd7\x95\xd7\x9d')" > apps/web/messages/he.json
git commit -qam "hebrew beside a colon"
printf 'Adds a total.\n' > "$TMP/body-silent.txt"
printf 'Adds a total.\nScreenshot: qa/screens/total-390.png, rendered at 390px, colon on the correct side.\n' > "$TMP/body-said.txt"
expect 1 "rtl-screenshot refuses Hebrew beside a neutral with a silent PR body" node "$G/check-rtl-screenshot.mjs" --base develop --body-file "$TMP/body-silent.txt"
expect 0 "rtl-screenshot passes when the body says it was looked at rendered" node "$G/check-rtl-screenshot.mjs" --base develop --body-file "$TMP/body-said.txt"
expect 2 "rtl-screenshot with no body is DID NOT RUN" node "$G/check-rtl-screenshot.mjs" --base develop

echo
echo "selftest: $pass ok, $fail failed"
[ "$fail" = 0 ]
