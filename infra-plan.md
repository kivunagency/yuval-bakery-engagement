---
client: yuval-bakery
doc: infra-plan
status: draft
created: 2026-09-25
owner: ido
links: [[agents/ido]] [[yuval-bakery]] [[ADR-001-stack]]
---

# תוכנית תשתית, YuvalBakery

מסמך זה ממיר את ADR-001 (alex, מאושר) לתוכנית הפעלה. אין לי Bash בסבב הזה ואין בדיקת חשבון חיה: כל פריט שדורש בדיקה מול ספק בפועל מסומן DID NOT RUN ומועבר לביצוע אנושי, לפי כלל 20.

## תוכנית תשתית

### סביבות

שלוש שכבות: local (חינם תמיד), DEV (Netlify + Supabase, חינם), PROD (Netlify + Supabase, חינם עד OPERATE).

```yaml
environments:
  local:
    stack: golden local-stack (~/.claude/shared/templates/local-stack/)
    db_engine: Postgres (parity guard: אותו מנוע כמו Supabase, לעולם לא SQLite-dev מול Postgres-prod)
    cost: 0
    used_for: פיתוח יומיומי, jordan/dana
  dev:
    branch: develop
    url: yuval-bakery-dev.netlify.app  # שם סופי ייקבע בהקמה בפועל
    auto_deploy: true
    supabase_project: "yuval-bakery-dev"  # פרויקט Supabase נפרד, free tier
    netlify_site: "yuval-bakery-dev"      # אתר Netlify נפרד, free tier
  prod:
    branch: main
    url: yuval-bakery.netlify.app         # דומיין מותאם מחובר בהמשך (ר' סעיף דומיין)
    auto_deploy: false
    supabase_project: "yuval-bakery-prod"
    netlify_site: "yuval-bakery"
promote_to_cloud_trigger:
  - "צריך preview לשיתוף עם יובל" -> preview חינמי אחד ב-Netlify (deploy preview על PR, עדיין 0 עלות)
  - "OPERATE (לקוחות משלמים דרך יובל, לא דרך Kivun)" -> אין ספק בתשלום חדש נדרש ב-MVP, שני הפרויקטים כבר free tier; אם Supabase Pro יידרש (גיבויים, סעיף בהמשך) זה מסומן בנפרד כאירוע OPERATE
```

**שני חשבונות, לא ארגון Kivun**: לפי ADR-001, Netlify ו-Supabase נפתחים תחת בעלות יובל, לא תחת ארגון Kivun הקיים (מגבלת 2 פרויקטים בארגון קיים + מיקום נכון של בעלות לאחר סיום המעורבות, שאין בה חוזה Kivun). זו החלטה הדורשת ביצוע אנושי, ר' Operational Handoff.

**Parity guard**: local-stack משתמש ב-Postgres מקומי (docker), לא SQLite, בדיוק כמו DEV/PROD ב-Supabase. אין לשנות מנוע בין סביבות.

### CI/CD Pipeline

GitHub Actions על הריפו של הפרויקט (ריפו נפרד מה-vault, ייפתח ב-BUILD Phase 0):

1. **PR ל-develop**: lint + typecheck + unit tests + Playwright smoke מול preview deploy של Netlify.
2. **merge ל-develop**: Netlify auto-deploy ל-DEV. Rule 7 regression.spec.js רץ מול DEV.
3. **PR מ-develop ל-main**: שער אישור. תיקון באג = PASS של deploy-engineer. פיצ'ר = + אישור ראן ב-Slack (או הודעה ישירה, אין ערוץ Slack ייעודי ללקוח משפחתי, ר' engagement.md סעיף 7). שינוי סכימה = + dba. אימות/תשלום/PII (הרשמת לקוח, MFA, תמונות השראה) = + erez.
4. **merge ל-main**: Netlify auto-deploy ל-PROD (ידני מאושר, לא אוטומטי לגמרי, לפי `auto_deploy: false`).

**תקציב דקות GitHub Actions**: free tier ל-repo פרטי = 2,000 דקות בחודש. לפרויקט בגודל הזה (build+test ~3-5 דקות לריצה, ~2-4 ריצות ביום בשיא הפיתוח) התקציב מספיק בנוחות; להעריך מחדש אם קצב ה-PR עולה משמעותית. אין תקרה כספית נוספת נדרשת מעבר לברירת המחדל של GitHub (free tier לא חורג לתשלום ללא הרשמה מפורשת לתוכנית בתשלום).

### Scheduled jobs: פקיעת הזמנות + keep-alive

**job-001 (US-9, ADR-001)**: Netlify Scheduled Function, כל 15 דקות, `UPDATE` אידמפוטנטי על הזמנות `payment_pending` שפג תוקפן, ומשחרר קיבולת באותה טרנזקציה. הריצה הזו היא גם מנגנון ה-keep-alive ל-Supabase (כותבת ל-DB בכל הרצה, מרחק זמן קצר בהרבה מסף 7 הימים של Pause).

**התראת כשל, חסרה ב-ADR-001, נוספת כאן**: אם ה-scheduled function נכשל (שגיאת DB, timeout) יותר מפעם אחת ברצף (שתי ריצות רצופות כושלות = 30 דקות), יש לשלוח התראה. Netlify Functions logs לא שולחים התראה יזומה כברירת מחדל; **פתרון מוצע**: ה-function עצמה כותבת timestamp הצלחה לטבלת `system_health`, ובדיקת GitHub Actions נפרדת (cron, פעם ביום) קוראת את ה-timestamp האחרון ופותחת issue / שולחת מייל אם עבר יותר מ-45 דקות מאז הצלחה אחרונה. זהו הפריט infra-005 ברשימת המשימות למטה. עד שהוא ייבנה, אי-זיהוי כשל ב-job-001 הוא NEEDS-HUMAN, לא PASS.

**סיכון מפורש (blindspot-003, ADR-001)**: אם Supabase דורש user query volume ולא כל כתיבה כדי למנוע Pause (לא מאומת בחיפוש של alex), יש להוסיף GitHub Actions cron נפרד עם `SELECT 1`. מסומן כ-fallback, ייבדק בפועל אחרי הקמת הפרויקט (DID NOT RUN כרגע, אין חשבון קיים לבדוק).

### ניטור והתראות

פרופורציונלי למטבח יחיד, לא ניטור ארגוני:

- **Vercel Analytics מקביל**: היות ואין Vercel, Netlify Analytics (בתשלום, $9/חודש) **לא** נרכש ב-MVP; מספיק Netlify's built-in deploy notifications (חינם) + Supabase Dashboard (שאילתות, שגיאות DB) + Resend Dashboard (שיעור שליחה/כשל מייל).
- **Sentry**: מומלץ להתקנה ראשונית בסיסית (free tier, עד 5K errors/חודש), מכסה גם client וגם server errors כולל ה-scheduled function. ר' משימת infra-006.
- **Rule 30 alerts** (טבלה למטה) הם שכבת הניטור העיקרית לפרויקט בגודל הזה: אין sre, אין cloud-ops עד OPERATE (Rule 3), כך שההתראות האלה **הן** הניטור עד אז.
- **cache_hit_rate_target**: לא רלוונטי, אין Upstash/Vercel KV בפרויקט הזה (ר' "דילוג" למטה).

### אסטרטגיית פריסה

Rolling deploy סטנדרטי של Netlify (כל push ל-branch מחובר בונה ומחליף אטומית). אין צורך ב-blue/green: תעבורה נמוכה של מטבח יחיד, ואין השבתה משמעותית בזמן build (~1-2 דקות). Rollback: Netlify שומר deploy history, rollback הוא כפתור אחד (deploy-engineer מבצע במקרה של כשל אחרי PROD).

## Upstash Redis / Vercel KV: דילוג מנומק

הפרויקט הזה **לא על Vercel** (הוחלט Netlify, ADR-001), כך ש-"Vercel KV" כפי שמתואר בתבנית לא רלוונטי טכנית. מבחינת הצורך:

- **Rate limiting**: יש `/api/*` routes אמיתיים (checkout, custom-cake, admin actions). תעבורה של מטבח יחיד (Instagram bio, ללא פרסום ממומן צפוי ב-MVP) לא מצדיקה Upstash בשלב זה; Netlify Functions מגיע עם הגנת rate-limit בסיסית ברמת הפלטפורמה. **סיכון**: אם יובל תרוץ קמפיין ממומן ותעבורה תזנק, אין הגנת rate-limit ייעודית. מסומן כ-upgrade_trigger: "תעבורה חורגת מ-~50 בקשות לדקה ממוצע -> להוסיף Upstash free tier (10K commands/day, $0)".
- **App-level caching**: אין route קריאה כבד (הקטלוג קטן, שאילתת Postgres זולה); ללא caching ב-MVP. CDN cache headers של Netlify (ברירת מחדל לנכסים סטטיים) מספיקים לתמונות קטלוג.

החלטה: לדלג על שתי השכבות ב-MVP, לתעד את סף השדרוג, ולוודא ש-`db-002` (capacity ledger) הוא נקודת האכיפה היחידה למניעת מירוץ קיבולת (לא caching, לא rate-limit).

## WAF baseline

הפרויקט הוא אתר ציבורי (הזמנות, קטלוג) ולכן זכאי ל-baseline לפי הכלל, אך ההחלטה ב-ADR-001 היא Netlify, לא Vercel/Cloudflare עם Firewall ייעודי. **Netlify Free לא כולל WAF ייעודי**; ההגנה הבסיסית שקיימת היא DDoS ברמת הפלטפורמה של Netlify (כלול). המלצה: אם/כאשר יעבור דומיין דרך Cloudflare (ר' סעיף דומיין), להפעיל Cloudflare proxy (חינם) עם OWASP managed rules בסיסי כ-WAF, גם ללא שדרוג לתשלום. מסומן כמשימת infra-007, לביצוע יחד עם הקמת ה-DNS.

```yaml
waf_baseline:
  platform: Cloudflare (proxy מול Netlify, free tier)
  managed_rules: OWASP core ruleset = ON (Cloudflare free tier תומך בסט בסיסי)
  custom_rules:
    - geo: לא נדרש, אין הגבלת מדינה עסקית (יעד B2C ישראלי, לא B2B עם רשימת גיאו סגורה)
    - bot_management: challenge לבוטים ידועים (כלול ב-Cloudflare free)
    - l7_rate: rate rules בסיסי ברמת edge, כמענה משלים ל"דילוג על Upstash" לעיל
  ddos: הגנת L7 כלולה ב-Netlify וב-Cloudflare כברירת מחדל
  provisioned_at: לפני PROD (לא רק ב-OPERATE, כי האתר ציבורי מיום ההשקה)
```

erez יגדיר אילו כללים ספציפיים נדרשים (Mode B, threat model), אני מספק את התשתית.

## גיבויים

**לפני OPERATE (Supabase free tier)**: **אין PITR בתוכנית החינמית**. זהו פער מפורש: אובדן נתונים בין גיבוי ידני לגיבוי ידני הוא אפשרי. מיטיגציה ב-MVP: `pg_dump` ידני שבועי (סקריפט ב-`scripts/backup-dev.sh`, מורץ ידנית או דרך GitHub Actions cron חינמי, נשמר ב-GitHub Actions artifact retention של 90 יום או Drive של יובל/ראן). זה **לא** תואם את דרישת כלל 11 (גיבוי יומי + 30 יום retention + בדיקת restore חודשית), ומוצהר ככה: כלל 11 חל באופן מלא רק מ-OPERATE.

**ב-OPERATE (ברגע שיש הזמנות אמיתיות בתשלום)**: שדרוג ל-Supabase Pro ($25/חודש) הוא הטריגר היחיד ל-PITR אמיתי + גיבוי יומי אוטומטי + retention 30 יום, בדיוק לפי כלל 11 ו-כלל 10 ("ONE paid prod cloud" ב-OPERATE). זו החלטת הוצאה שדורשת אישור מפורש (ראן/יובל), לא ברירת מחדל אוטומטית. עד אז: **הגבלת התחייבות מפורשת ליובל** שנתוני הזמנות/לקוחות אינם מגובים ברמת SLA לפני שדרוג זה.

## Secrets handling

- כל secret (Supabase service_role, Resend API key, VAPID private key) חי ב-Netlify Environment Variables, מוצפן, לא בקוד ולא ב-git. `.env.example` בריפו לתיעוד השמות בלבד.
- DEV ו-PROD מחזיקים ערכות נפרדות (Supabase project שונה לכל סביבה, כך שאין סיכון שמפתח PROD דולף דרך build של DEV).
- `.qa.env` (gitignored) + `.qa.env.example` מוקמים ב-Phase QA לפי כלל 22, לא כאן.
- service_role key: גישה מוגבלת ל-server-only code (`import 'server-only'`, לפי כלל 2), לעולם לא ל-client bundle.

## דומיין, DNS ודוא"ל שולח (Resend)

**דומיין**: פריט פתוח ב-PRD (סעיף 10, שאלה 2: שם עסק ודומיין טרם אושרו). עד לאישור, PROD רץ על תת-דומיין Netlify (`yuval-bakery.netlify.app`). כשיאושר דומיין:

1. רכישת דומיין (Namecheap/GoDaddy או Cloudflare Registrar, ~$10-15/שנה, ביצוע אנושי, ר' Rule 30 טבלה למטה).
2. חיבור DNS: אם דרך Cloudflare (מומלץ עבור ה-WAF baseline לעיל), `CNAME`/`A` record מפנה ל-Netlify.
3. **SPF/DKIM ל-Resend**: יש להוסיף רשומות DNS שResend מספק (TXT ל-SPF, CNAME/TXT ל-DKIM) על הדומיין הנבחר, אחרת מיילים (התראות הזמנה, אישור תשלום) עלולים להיכנס לספאם. זהו שלב חובה **לפני** launch, לא אופציונלי, ומחייב גישה בפועל לפאנל ה-DNS (ביצוע אנושי).
4. DID NOT RUN: אין דומיין קיים לבדוק כרגע; כל הפריטים בסעיף זה תלויים בהחלטת יובל.

## טבלת כלל 30: תקרות והתראות

| ספק | יחידת חיוב | תקרה קשיחה | התראה (סף) | נמען |
|---|---|---|---|---|
| Netlify | דקות build לחודש / קריאות function לחודש | 300 דק' build, 125K קריאות function (free tier, ללא שדרוג אוטומטי) | 80% מכל אחד מהם | יובל (מייל חשבון) + עותק לראן |
| Supabase | גודל DB (MB) + אחסון (GB) | 500MB DB, 1GB Storage (free tier) | 80% מכל אחד | יובל + עותק לראן |
| Resend | מיילים ליום | 100/יום (free tier) | 80 ביום ממושך | יובל + עותק לראן |
| דומיין (כשייקנה) | חיוב שנתי קבוע | חד פעמי, לא מדוד, אין צורך בהתראת שימוש | חידוש שנתי (תזכורת יומן, לא תקרת שימוש) | יובל |

כל תקרה מוגדרת ביום פתיחת החשבון (infra-003 ברשימת המשימות), לא בדיעבד. עד שהחשבונות נפתחים בפועל, מצב זה הוא DID NOT RUN.

## הפעלת מרשם הפעולות (כלל 27)

ADR-001 קבע GO ל-5 פעולות ליבה (`markOrderPaid`, `approveCustomCakeRequest`, `declineCustomCakeRequest`, `generateDeliveryList`, `updateDayCapacity`) דרך `~/.claude/shared/templates/agent-ops-registry/`. זו משימת backend (ops-registry-001 כבר ב-tasks.json), לא תשתית נפרדת; אני מוודא שהיא מתועדת גם כאן כי `deploy-engineer` בודק את קיומה כשער לפני PROD.

## Operational Handoff

**מצב נוכחי**: אין OPERATE עדיין (אין לקוחות משלמים דרך המערכת, אין SLA). לפי engagement.md, הפעלת cloud-ops-lead/sre/finops נבחנת מחדש ב-LAUNCH.

**פעולות אנושיות נדרשות לפני BUILD (לא אני, לא סוכן)**:
1. **פתיחת חשבון Netlify חדש** תחת בעלות יובל (לא Kivun), עם 2FA.
2. **פתיחת חשבון Supabase חדש** תחת בעלות יובל, עם 2FA, ויצירת שני פרויקטים (`yuval-bakery-dev`, `yuval-bakery-prod`).
3. **פתיחת חשבון Resend** (יכול להיות תחת יובל או ראן זמנית, לתעד את הבחירה).
4. **מי מחזיק את הסיסמאות בפועל** (blindspot-004 ב-tasks.json): יובל אינה טכנית, יש להחליט מראש מי (ראן? יובל עצמה עם מנהל סיסמאות?) אחראי על תגובה להתראות כלל 30 ומי יש לו גישת admin בפועל. לא הוחלט, נדרש לפני infra-001.
5. **שם עסק, דומיין, מספר עוסק**: נדרש לפני חיבור DNS/SPF/DKIM ולפני compliance-002 (ס.14C).

**כשמגיע LAUNCH/OPERATE, תדריך ל-cloud-ops-lead** (יינתן בפועל כשהשלב מגיע, לא כרגע): המערכת רצה על Netlify+Supabase free/Pro תחת חשבון הלקוחה עצמה (לא ארגון Kivun), הבידול היחיד מ"רגיל" הוא היעדר SLA פורמלי מול Kivun וחוסר staff טכני אצל הלקוחה, כך שכל alert חייב תגובה אנושית ברורה מוגדרת מראש (סעיף 4 לעיל). נקודת כאב ידועה: אין PITR עד שדרוג ל-Supabase Pro. המלצת SLO ראשונית: זמינות 99% (לא 99.9%, עסק חד-מטבחי, לא קריטי-חיים), זמן תגובה checkout p95 מתחת ל-2 שניות.

---

# JSON DevOps task list

```json
[
  {
    "task_id": "OPS-001",
    "title": "פתיחת חשבונות Netlify ו-Supabase תחת בעלות יובל",
    "description": "פתיחת חשבון Netlify וחשבון Supabase חדשים תחת בעלות יובל עם 2FA, ולא תחת ארגון Kivun הקיים, כפי שנקבע ב-ADR-001.",
    "story_points": 1
  },
  {
    "task_id": "OPS-002",
    "title": "יצירת פרויקטי Supabase נפרדים ל-DEV ול-PROD",
    "description": "שני פרויקטי Supabase (yuval-bakery-dev, yuval-bakery-prod) בחשבון יובל, ללא שיתוף נתונים ביניהם.",
    "story_points": 1
  },
  {
    "task_id": "OPS-003",
    "title": "יצירת אתרי Netlify נפרדים ל-DEV ול-PROD עם חיבור ענפי git",
    "description": "yuval-bakery-dev מחובר ל-develop עם auto_deploy, yuval-bakery מחובר ל-main ללא auto_deploy עד אישור ידני.",
    "story_points": 2
  },
  {
    "task_id": "OPS-004",
    "title": "הגדרת תקרות והתראות כלל 30 לכל חשבון",
    "description": "תקרה קשיחה והתראה ב-80 אחוז ליחידת החיוב של Netlify, Supabase ו-Resend, לפי טבלת infra-plan.md, ביום ההקמה עצמו.",
    "story_points": 2
  },
  {
    "task_id": "OPS-005",
    "title": "מנגנון התראת כשל ל-scheduled function של פקיעת הזמנות",
    "description": "בדיקת GitHub Actions יומית הקוראת timestamp הצלחה אחרון מטבלת system_health ופותחת התראה אם עברו יותר מ-45 דקות ללא הרצה מוצלחת.",
    "story_points": 3
  },
  {
    "task_id": "OPS-006",
    "title": "התקנת Sentry בסיסי (client + server + scheduled function)",
    "description": "חשבון Sentry free tier, כולל את ה-scheduled function כמקור שגיאות נפרד, לניטור פרופורציונלי למטבח יחיד.",
    "story_points": 2
  },
  {
    "task_id": "OPS-007",
    "title": "חיבור Cloudflare proxy ו-WAF בסיסי כשדומיין נקבע",
    "description": "הפניית DNS דרך Cloudflare (proxied) מול Netlify, הפעלת OWASP managed rules בסיסי בתוכנית החינמית, ברגע שדומיין ועוסק מאושרים.",
    "story_points": 2
  },
  {
    "task_id": "OPS-008",
    "title": "הגדרת SPF ו-DKIM לדומיין השליחה של Resend",
    "description": "הוספת רשומות DNS שResend מספק (TXT SPF, DKIM) על הדומיין הנבחר, לפני launch, כדי למנוע נפילה לספאם של מיילי הזמנה והתראה.",
    "story_points": 1
  },
  {
    "task_id": "OPS-009",
    "title": "סקריפט גיבוי ידני שבועי (pg_dump) עד שדרוג Supabase Pro",
    "description": "scripts/backup-dev.sh, הרצה שבועית ידנית או דרך GitHub Actions cron חינמי, שמירת dump ב-artifact retention או Drive, כתחליף זמני ל-PITR שאינו כלול ב-free tier.",
    "story_points": 2
  },
  {
    "task_id": "OPS-010",
    "title": "תיעוד בעל האחריות התפעולית (סיסמאות, תגובה להתראות)",
    "description": "החלטה מפורשת מי מחזיק גישת admin וסיסמאות בפועל לאחר LAUNCH, ומי אחראי לתגובה להתראות כלל 30, לפני פתיחת החשבונות (OPS-001).",
    "story_points": 1
  }
]
```

[[agents/ido]] [[yuval-bakery]] [[ADR-001-stack]]
