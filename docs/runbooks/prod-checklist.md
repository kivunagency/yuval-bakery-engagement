<div dir="rtl" lang="he">

# PROD מ-main: רשימת הכנה לאישור של רן

מבוסס על <bdi dir="ltr">`docs/runbooks/environments.md`</bdi> ו-<bdi dir="ltr">`docs/runbooks/first-admin.md`</bdi> (מוזגו ל-<bdi dir="ltr">`develop`</bdi> ב-PR #55). המסמך הזה לא מפרס כלום. כל שלב שמסומן **שער** מחכה לאישור מפורש של רן בכתב.

## מצב נכון ל-2026-09-29

- ב-<bdi dir="ltr">`main`</bdi> יש רק מסמכים. אין בו <bdi dir="ltr">`apps/web`</bdi>, אין <bdi dir="ltr">`netlify.toml`</bdi> ואין מיגרציות. אתר PROD שיחובר ל-<bdi dir="ltr">`main`</bdi> היום ייכשל ב-build.
- <bdi dir="ltr">`develop`</bdi> מקדים את <bdi dir="ltr">`main`</bdi> ב-114 commits (כל הקוד).
- PR #55 (עבודה בלי דומיין, ו-<bdi dir="ltr">`environments.md`</bdi>) מוזג ל-<bdi dir="ltr">`develop`</bdi>.
- רן אישר את שני השערים בכתב ב-2026-09-29. הביצוע עדיין לפי הסדר שבמסמך.
- ב-Free של Supabase מותרים שני פרויקטים פעילים. DEV בפרנקפורט, ולכן את הפרויקט הריק במומבאי צריך להשהות או למחוק לפני PROD (החלטה של רן או של יובל).

לכן הסדר הוא: PR #55 נכנס ל-<bdi dir="ltr">`develop`</bdi>, DEV עולה ונבדק, ורק אז קידום <bdi dir="ltr">`develop`</bdi> ל-<bdi dir="ltr">`main`</bdi>.

## שלב א: תנאים מוקדמים

- [x] PR #55 מוזג ל-<bdi dir="ltr">`develop`</bdi>.
- [ ] DEV חי, smoke ו-IS 5568 עברו על הכתובת החיה (environments.md, סעיף 4). תוצאה שלא רצה נרשמת DID NOT RUN.
- [ ] מיובל: שם העסק, סטטוס ומספר עוסק, ימי עבודה, אלרגנים לכל מוצר, תמונות, חלונות תוקף לתשלום. בלעדיהם אין פרטי עסק (s.14C) ואלרגנים באתר הציבורי.
- [ ] **שער 1:** רן מאשר קידום <bdi dir="ltr">`develop`</bdi> ל-<bdi dir="ltr">`main`</bdi> (PR מ-<bdi dir="ltr">`develop`</bdi> אל <bdi dir="ltr">`main`</bdi>).

## שלב ב: Supabase PROD (רן או יובל יוצרים ביד בדשבורד)

- [ ] פרויקט <bdi dir="ltr">`yuval-bakery-prod`</bdi>, אזור <bdi dir="ltr">`eu-central-1`</bdi>, תוכנית Free, בארגון של יובל. סשן של Claude לא יכול ליצור פרויקט; מכאן והלאה הוא עובד עם הטוקן של יובל.
- [ ] כל הקבצים ב-<bdi dir="ltr">`apps/web/supabase/migrations/`</bdi> מ-<bdi dir="ltr">`main`</bdi>, לפי סדר השמות. **בלי** <bdi dir="ltr">`seed.sql`</bdi>.
- [ ] Security Advisor ו-Performance Advisor: כל ממצא מתוקן או נרשם ב-SYSTEM-CONTRACT.
- [ ] הגדרות Auth (הטבלה למטה).
- [ ] Spend cap פעיל, מייל שימוש ליובל (רן כבר לא חבר בארגון).

</div>

| Auth setting | PROD value |
|---|---|
| Site URL | `https://yuval-bakery.netlify.app` |
| Redirect URLs | `https://yuval-bakery.netlify.app/**` |
| Email provider / Confirm email | on / on |
| Minimum password length | 12 |
| MFA TOTP | enroll + verify on |
| Phone provider | off |
| Allow new users to sign up | **off** |
| Custom SMTP | none (no domain) |

<div dir="rtl" lang="he">

## שלב ג: Netlify PROD (יובל יוצרת)

- [ ] אתר <bdi dir="ltr">`yuval-bakery`</bdi> מה-repo, Base directory <bdi dir="ltr">`apps/web`</bdi>, Production branch <bdi dir="ltr">`main`</bdi>.
- [ ] **Stop auto publishing** מופעל לפני החיבור הראשון ל-repo.
- [ ] Deploy previews ו-branch deploys כבויים באתר הזה (SEC-020).
- [ ] תוכנית Free בלי שדרוג אוטומטי, התראת שימוש ב-80%.
- [ ] משתני סביבה (הטבלה למטה), מוקלדים על ידי יובל ב-Netlify UI. אף ערך סודי לא נכנס ל-git או לצ'אט.
- [ ] לקח מ-DEV: משתנים ציבוריים (<bdi dir="ltr">`NEXT_PUBLIC_*`</bdi>, <bdi dir="ltr">`APP_ENV`</bdi>, <bdi dir="ltr">`SITE_URL`</bdi>) מייבאים **בלי** הסימון Contains secret values. ב-DEV ה-anon key נשמר כנקודות מוסתרות, וכל דף נפל בשגיאת ByteString. אחרי הייבוא בודקים כל ערך אחד אחד.
- [ ] לקח מ-DEV: אם האתר נוצר דרך ה-API, מוסיפים את ה-plugin של Next.js, ובחיבור ה-repo מוודאים Base directory <bdi dir="ltr">`apps/web`</bdi> ו-branch <bdi dir="ltr">`main`</bdi> (ברירת המחדל הייתה בלי Base directory).

</div>

| Variable | PROD value | Secret | Note |
|---|---|---|---|
| `APP_ENV` | `prod` | no | **Must be set.** Unset means `local`, which turns customer email and customer accounts ON (`lib/server/features/index.ts`) |
| `SITE_URL` | `https://yuval-bakery.netlify.app` | no | |
| `NEXT_PUBLIC_SUPABASE_URL` | PROD project URL | no | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | PROD anon key | no | public by design |
| `SUPABASE_SERVICE_ROLE_KEY` | PROD service role key | **yes** | never the DEV key |
| `CONFIRMATION_LINK_SECRET` | new 32+ random chars | **yes** | different from DEV |
| `EMAIL_PROVIDER` | `resend` | no | |
| `RESEND_API_KEY` | Yuval's key | **yes** | |
| `EMAIL_FROM` | `onboarding@resend.dev` | no | until a domain exists |
| `EMAIL_RECIPIENT_ALLOWLIST` | Resend account owner's address | yes | |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | a new pair, not DEV's | private **yes** | `npx web-push generate-vapid-keys` |
| `CUSTOMER_EMAIL_ENABLED` | leave unset | no | off in prod |
| `CUSTOMER_ACCOUNTS_ENABLED` | leave unset | no | off in prod |
| `OPS_REGISTRY_ENABLED` | leave unset | no | off in prod (threat model 3.7) |
| `OPS_REGISTRY_TOKEN_SECRET` | not set | | only needed if the registry is on |

<div dir="rtl" lang="he">

- [ ] Resend: התראה ב-80 מיילים ביום (התקרה נאכפת גם בקוד).

## שלב ד: פריסה ראשונה

- [ ] **שער 2:** רן מאשר פריסה ראשונה של PROD.
- [ ] Deploy ידני של <bdi dir="ltr">`main`</bdi> ב-Netlify, ואז Publish.
- [ ] Functions בדשבורד: <bdi dir="ltr">`expire-orders`</bdi>, <bdi dir="ltr">`retention-daily`</bdi>, <bdi dir="ltr">`capacity-rollforward`</bdi> רשומות. אחרי 15 דקות שורה חדשה ב-<bdi dir="ltr">`cron_heartbeats`</bdi>.

## שלב ה: המנהלת הראשונה (first-admin.md)

- [ ] יובל יוצרת את עצמה ב-Auth, עם סיסמה שרק היא מקלידה, Auto Confirm.
- [ ] שורה ב-<bdi dir="ltr">`admins`</bdi> דרך ה-SQL שב-runbook. התוצאה: שורה אחת.
- [ ] כניסה ב-<bdi dir="ltr">`/admin/login`</bdi>, סריקת QR, וב-<bdi dir="ltr">`admins.mfa_enrolled_at`</bdi> מופיע זמן.
- [ ] יובל ממלאת בהגדרות את פרטי העסק וקישורי התשלום.

## שלב ו: בדיקה על הכתובת החיה

</div>

```bash
cd apps/web
SMOKE_BASE_URL=https://yuval-bakery.netlify.app npx playwright test -c qa/playwright.config.js --project=smoke
```

<div dir="rtl" lang="he">

- [ ] smoke עבר, עם צילום מסך של דף הבית בעברית.
- [ ] <bdi dir="ltr">`/register`</bdi> מחזיר 404 ואין שדה אימייל ב-checkout (סימן ש-<bdi dir="ltr">`APP_ENV=prod`</bdi> נקלט).
- [ ] אין "deployed" בלי כניסה בדפדפן לכתובת החיה.

## החלטות פתוחות של רן

- קוד שחזור לאפליקציית האימות של יובל (TOTP שני), מ-first-admin.md.
- שם האתר ב-Netlify (<bdi dir="ltr">`yuval-bakery`</bdi>) הוא ההצעה מ-environments.md; אם תפוס, Site URL ו-<bdi dir="ltr">`SITE_URL`</bdi> משתנים יחד.

</div>
