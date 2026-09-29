<div dir="rtl" lang="he">

# הקמת DEV ו-PROD (infra-001, infra-003)

מה מוקם, באיזה סדר, ואיך בודקים שכל שלב עבר. כל החשבונות של יובל (ADR-001), לא של Kivun. אין דומיין: שני האתרים על כתובת <bdi dir="ltr">`netlify.app`</bdi>.

| | DEV | PROD |
|---|---|---|
| ענף | <bdi dir="ltr">`develop`</bdi> | <bdi dir="ltr">`main`</bdi> |
| פרויקט Supabase | <bdi dir="ltr">`yuval-bakery-dev`</bdi> | <bdi dir="ltr">`yuval-bakery-prod`</bdi> |
| אתר Netlify | <bdi dir="ltr">`yuval-bakery-dev`</bdi> | <bdi dir="ltr">`yuval-bakery`</bdi> |
| פריסה אוטומטית | כן, בכל push | לא. פריסה ראשונה רק באישור של רן |
| אזור | <bdi dir="ltr">`eu-central-1`</bdi> | <bdi dir="ltr">`eu-central-1`</bdi> |

## 1. Supabase, לכל סביבה

1. פרויקט חדש בארגון של יובל, תוכנית Free.
2. כל המיגרציות מ-<bdi dir="ltr">`apps/web/supabase/migrations/`</bdi>, לפי סדר השמות. בלי <bdi dir="ltr">`seed.sql`</bdi>: הוא סינתטי, לבדיקות מקומיות בלבד.
3. אחרי המיגרציות: Security Advisor ו-Performance Advisor. כל ממצא נרשם ב-SYSTEM-CONTRACT או מתוקן.
4. Authentication, כמו ב-<bdi dir="ltr">`scripts/local-stack/up.sh`</bdi>:

</div>

| Setting | Value | Why |
|---|---|---|
| Site URL | the environment's `https://<site>.netlify.app` | links in Auth mail |
| Redirect URLs | `https://<site>.netlify.app/**` | same |
| Email provider | on | admin sign-in |
| Confirm email | on | |
| Minimum password length | 12 | first-admin runbook |
| MFA TOTP | enroll + verify on | admin aal2 |
| Phone provider | off | |
| Allow new users to sign up | **off** while `CUSTOMER_ACCOUNTS_ENABLED` is off | otherwise the anon key can create Auth users straight through Supabase, around our closed `/api/customers`. Admins are created in the dashboard, which works with sign-up off |
| Custom SMTP | none until a domain exists | the built-in mail reaches only the project team |

<div dir="rtl" lang="he">

5. המנהלת הראשונה: לפי <bdi dir="ltr">`docs/runbooks/first-admin.md`</bdi>.

## 2. Netlify, לכל סביבה

- אתר מה-repo <bdi dir="ltr">`kivunagency/yuval-bakery-engagement`</bdi>, Base directory <bdi dir="ltr">`apps/web`</bdi>. פקודת ה-build וה-functions כבר ב-<bdi dir="ltr">`apps/web/netlify.toml`</bdi>.
- Production branch: DEV על <bdi dir="ltr">`develop`</bdi>, PROD על <bdi dir="ltr">`main`</bdi>. ב-PROD: Stop auto publishing עד האישור.
- Deploy previews ו-branch deploys רק באתר DEV (SEC-020).
- המשימות המתוזמנות (<bdi dir="ltr">`expire-orders`</bdi>, <bdi dir="ltr">`retention-daily`</bdi>, <bdi dir="ltr">`capacity-rollforward`</bdi>) נרשמות מעצמן מה-schedule שבכל function. בדיקה: Functions בדשבורד, ואחרי 15 דקות שורה חדשה ב-<bdi dir="ltr">`cron_heartbeats`</bdi>.

משתני סביבה. ערכים סודיים רק ב-Netlify, לעולם לא ב-git:

</div>

| Variable | DEV | PROD | Secret |
|---|---|---|---|
| `APP_ENV` | `dev` | `prod` | no |
| `SITE_URL` | DEV `https://...netlify.app` | PROD `https://...netlify.app` | no |
| `NEXT_PUBLIC_SUPABASE_URL` | DEV project URL | PROD project URL | no |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | DEV anon key | PROD anon key | no (public by design) |
| `SUPABASE_SERVICE_ROLE_KEY` | DEV | PROD | **yes** |
| `CONFIRMATION_LINK_SECRET` | 32+ random chars | different 32+ random chars | **yes** |
| `EMAIL_PROVIDER` | `resend` | `resend` | no |
| `RESEND_API_KEY` | Yuval's key | Yuval's key | **yes** |
| `EMAIL_FROM` | `onboarding@resend.dev` | `onboarding@resend.dev` | no |
| `EMAIL_RECIPIENT_ALLOWLIST` | Resend account owner's address | same | yes (an address) |
| `CUSTOMER_EMAIL_ENABLED` | unset (off) | unset (off) | no |
| `CUSTOMER_ACCOUNTS_ENABLED` | unset (off) | unset (off) | no |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | own pair (`npx web-push generate-vapid-keys`) | a different pair | private key **yes** |
| `OPS_REGISTRY_ENABLED` | unset (off) | unset (off, threat model) | no |

<div dir="rtl" lang="he">

## 3. תקרות הוצאה והתראות (כלל 30, infra-003)

| ספק | מה מגדירים | איפה |
|---|---|---|
| Supabase | Spend cap פעיל (ברירת מחדל ב-Free) ומייל שימוש ליובל ולרן | Organization, ואז Billing |
| Netlify | תוכנית Free בלי שדרוג אוטומטי, התראת שימוש ב-80% | Team, ואז Billing ו-Usage |
| Resend | Free: 100 ביום. התראה ב-80. התקרה נאכפת גם בקוד (<bdi dir="ltr">`email_daily_hard_cap`</bdi>) | Resend dashboard |

## 4. בדיקה על הכתובת החיה (DEV)

</div>

```bash
cd apps/web
SMOKE_BASE_URL=https://<dev-site>.netlify.app npx playwright test -c qa/playwright.config.js --project=smoke
```

<div dir="rtl" lang="he">

IS 5568 מול אותה כתובת (בלי DB מקומי; הדוח נכתב ל-<bdi dir="ltr">`apps/web/test-results/is5568-report.md`</bdi>):

</div>

```bash
E2E_BASE_URL=https://<dev-site>.netlify.app npx playwright test -c qa/playwright.config.js --project=mobile qa/regression.is5568.spec.js
```

<div dir="rtl" lang="he">

דפי החשבון מחזירים 404 כל עוד החשבונות כבויים, ומופיעים בדוח כ-DID NOT RUN. בדיקה שלא רצה נרשמת DID NOT RUN, לא PASSED.

## כשיהיה דומיין

דומיין מאומת ב-Resend (SPF ו-DKIM), <bdi dir="ltr">`EMAIL_FROM`</bdi> על הדומיין, מוחקים את <bdi dir="ltr">`EMAIL_RECIPIENT_ALLOWLIST`</bdi>, Custom SMTP ב-Supabase דרך Resend, ואז <bdi dir="ltr">`CUSTOMER_EMAIL_ENABLED=true`</bdi>, <bdi dir="ltr">`CUSTOMER_ACCOUNTS_ENABLED=true`</bdi> ו-Allow new users to sign up. כל אחד מהם בנפרד, עם בדיקה.

</div>
