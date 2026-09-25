---
client: yuval-bakery
doc: compliance-schema-review
mode: B (build-pipeline Phase 3.5.5)
owner: rotem
created: 2026-09-25
inputs: compliance-spec.md, 04-architecture/DB-PLAN.md, output/db/migrations/2026092512*.sql (9 files), output/db/rls_policies.sql, 05-prds/PRD-01-ordering-app.md (US-0c, US-0d)
verdict: BLOCK (5 items, all small; details in section 3)
links: [[agents/rotem]] [[yuval-bakery]]
---

# סקירת ציות לסכמה: אפליקציית ההזמנות של יובל

[[agents/rotem]] [[yuval-bakery]]

> אני לא עורכת דין. זו סקירה של הסכמה מול compliance-spec.md, לא חוות דעת משפטית. הבסיס החוקי לכל ממצא מפנה לסעיף במפרט, ששם מסומן מה מאומת ומה לייעוץ משפטי.

**Bootstrap:** קובץ המוח `YuvalBakery.md` לא קיים בנתיב הצפוי; learnings.jsonl מכיל שורה אחת (shir), אין שורות rotem. עבדתי ישירות מהמקורות הראשיים שברשימת inputs.

**מה נקרא בפועל:** כל 9 קבצי המיגרציה במלואם, rls_policies.sql, DB-PLAN.md, והמפרט. לא הורץ דבר (אין לי Bash): הממצאים מבוססים על קריאת SQL, ושניים מהם (B1a, B2) הם התנהגות מוגדרת של Postgres שכדאי ש-dba ישחזר בקונטיינר שכבר הרים, כדי לראות את השגיאה בעיניים לפני התיקון.

**תיאום:** dba עורך כרגע את קובץ הפונקציות (`20260925120800_functions_capacity_and_orders.sql`) בגלל באגי קיבולת. רוב הבקשות כאן נוגעות באותו קובץ. להחיל אחרי תיקוני הקיבולת, באותו PR או ב-PR עוקב, לא במקביל על אותן שורות.

---

## 1. טבלת מצב לפי טבלה

מקרא: ✅ עובר, ❌ נכשל, ⚠️ עובר עם בקשה לא חוסמת, n/a לא רלוונטי.

| טבלה | הסכמה | שמירה / purge | מחיקה / אנונימיזציה | צמצום נתונים | הערה |
|---|---|---|---|---|---|
| `customers` | ⚠️ עמודות קיימות, אבל הלקוח יכול לכתוב אותן ישירות (B3) | ⚠️ `retention_until` לא מאוכלס, אין sweep לחוסר פעילות | ❌ מחיקת חשבון נכשלת (B2) | ✅ יום+חודש בלבד | ⚠️ אין CHECK שיום וחודש מגיעים בזוג |
| `consent_events` | ✅ append-only, trigger, גרסה, מקור, זמן | ⚠️ אין purge ל-7 שנים מהביטול | ❌ ה-FK מתנגש עם ה-trigger (B2) | ✅ | ❌ ראיה ניתנת לזיוף דרך הפונקציה (B3) |
| `privacy_requests` | n/a | ⚠️ אין שמירה/purge (מפרט: 3 שנים) | ✅ SET NULL, אין trigger מתנגש | ✅ | ✅ `due_at` +30 יום |
| `orders` | ✅ שלוש עמודות גרסה NOT NULL | ❌ `retention_until` אף פעם לא מאוכלס, אין sweep (B1) | ❌ האנונימיזציה נכשלת על משלוח ולא מכסה אורחים (B1) | ⚠️ ה-PDF מכיל כתובת מלאה (סעיף 2) | ❌ קישור האישור לא ניתן לביטול (B5) |
| `order_items` | n/a | ✅ נתון פיננסי בלבד | ✅ אין PII | ✅ snapshot שם מוצר בלבד | |
| `order_attempt_log` | n/a | ❌ טלפון + IP, אין purge בכלל (B4) | n/a | ⚠️ עדיף hash | |
| `order_lookup_attempts` | n/a | ✅ `fn_purge_old_lookup_attempts`, 90 יום | n/a | ⚠️ עדיף hash; purge שקט כשהמפתח חסר | |
| `custom_cake_requests` | ✅ `upload_rights_confirmed_at NOT NULL` | ❌ עמודות קיימות, שום דבר לא מאכלס או מנקה (B1) | ❌ לא מכוסה ע"י `fn_anonymize_customer` (B1) | ✅ אין promote-to-catalog | |
| `custom_cake_photos` | n/a | ❌ אין מנגנון 30 יום (B1) | ⚠️ `DELETE` דרך Data API משאיר קובץ יתום | ✅ admin בלבד | bucket עוד לא נוצר (DB-PLAN 9) |
| `products`, `product_photos` | n/a | n/a | n/a | ✅ CHECK אלרגנים + alt | ✅ |
| `delivery_zones`, `delivery_zone_cities` | n/a | n/a | n/a | ✅ אין PII | ✅ |
| `delivery_list_links` | n/a | ⚠️ אין CHECK על תקרת תפוגה | n/a | ✅ הרשימה לא נשמרת | ⚠️ עמודה בשם `token` שמחזיקה hash |
| `push_subscriptions` | n/a | ⚠️ שורות מבוטלות לא נמחקות | n/a | ✅ admin בלבד, אין PII של לקוח | |
| `audit_log` | n/a | ❌ אין שמירה, וה-trigger חוסם כל מחיקה לנצח | n/a | ❌ IP גולמי ב-`actor_id` (B4) | ✅ שאר הקריאות בלי PII |
| `app_settings` | n/a | ⚠️ חסרים מפתחות (סעיף 5) | n/a | ✅ | ⚠️ רצפה/תקרה רק באפליקציה |
| `capacity_day_ledger`, `cron_heartbeats` | n/a | ⚠️ אין heartbeat לג'וב השמירה | n/a | ✅ | |

**מה עובר היטב, ששווה לציין:** טבלת `consent_events` בנויה בדיוק כמו במפרט; שלוש גרסאות הנוסח חובה על כל הזמנה; יום הולדת בלי שנה; `upload_rights_confirmed_at` חובה; אין מסלול קידום תמונה לקטלוג; CHECK האלרגנים וה-alt על `products`; שער US-0c נאכף ב-trigger ולא רק בקוד; חיפוש US-0d דורש טלפון ומספר הזמנה יחד, מחזיר תשובה אחידה, ומסכה את הכתובת.

---

## 2. US-0c ו-US-0d מול החוק

**US-0c (אישור בכתב, ס.14ג(ב)):** המנגנון נכון בכיוון. ה-trigger `trg_orders_guard_fulfillment` חוסם `fulfilled` בלי ערוץ אישור, וזה בדיוק מה שנדרש. שתי בעיות, שתיהן ב-B5: הפונקציה שפותחת את השער פתוחה לכל משתמש מחובר ולא נעולה אחרי קריאה ראשונה, וה-CHECK של 24 חודשים לא משאיר דרך לבטל קישור או למחוק את ה-PDF כשמגיע זמן האנונימיזציה. שאלת "האם PDF להורדה + קישור ב-WhatsApp מקיים את ס.14ג(ב)" נשארת לייעוץ משפטי לפני השקה, כפי שה-PRD כבר קובע.

**US-0d (חיפוש לפי טלפון + מספר הזמנה):** ✅ ברמת הסכמה. שלוש הערות:
1. **המסכה בתצוגה לא שווה הרבה אם ההורדה החוזרת מחזירה PDF עם כתובת מלאה.** US-0d מאפשר "לראות ולהוריד מחדש את האישור". מי שיודע טלפון ומספר הזמנה של מישהו אחר יקבל את הכתובת המלאה מה-PDF. ההמלצה: ה-PDF לא יכיל כתובת רחוב ולא טלפון. ס.14ג(ב) דורש פרטי עסק, מוצר, מחיר, מועד ותנאי ביטול, ולא את כתובת הלקוח (לאימות בייעוץ המשפטי שכבר מתוכנן). זה גם מקטין את מה שנחשף ב-24 חודשי חיי הקישור. בעלים: dana/jordan בתבנית ה-PDF, לא dba.
2. **הזמנה שעברה אנונימיזציה עדיין ניתנת לחיפוש.** אחרי אנונימיזציה של אורח `guest_phone = 'purged'`, והפונקציה מוענקת ל-anon ישירות כ-RPC, כך שנרמול E.164 של השרת לא עומד בדרך. בקשה: `AND o.pii_purged_at IS NULL` בתנאי ה-WHERE (N7).
3. **לארז, לא חוסם אצלי:** `p_ip_address` מגיע מהקורא. בקריאת RPC ישירה (הפונקציה מוענקת ל-anon) מגבלת ה-IP ניתנת לעקיפה בזיוף ערך. מגבלת הטלפון עדיין מחזיקה.

---

## 3. חוסמים (BLOCK): חמישה פריטים, כולם קטנים

### B1. מדיניות השמירה וזכות המחיקה לא ניתנות לביצוע

הודעת הפרטיות לפי ס.11 תבטיח ללקוח תקופת שמירה ואנונימיזציה (מפרט סעיפים 3, 4.6, 6). בסכמה הנוכחית ההבטחה הזו לא ניתנת לקיום, בארבע נקודות:

**B1a. `fn_anonymize_customer` נכשלת על כל הזמנת משלוח.** היא מאפסת `delivery_address = NULL`, וה-CHECK על `orders` דורש `fulfillment_type = 'pickup' OR (delivery_address IS NOT NULL AND delivery_city IS NOT NULL)`. כל לקוח עם הזמנת משלוח אחת יקבל שגיאה ומחיקת החשבון תתגלגל אחורה.
- בקשה: לשנות את ה-CHECK ל-
  `CHECK (pii_purged_at IS NOT NULL OR fulfillment_type = 'pickup' OR (delivery_address IS NOT NULL AND delivery_city IS NOT NULL))`
- ובאותו אופן את CHECK הזיהוי:
  `CHECK (pii_purged_at IS NOT NULL OR customer_id IS NOT NULL OR (guest_name IS NOT NULL AND guest_phone IS NOT NULL))`
  ואז האנונימיזציה יכולה לאפס `guest_name`/`guest_phone` ל-NULL במקום ערך קבוע.

**B1b. הזמנות אורח לא מכוסות בכלל.** הפונקציה בוחרת `WHERE customer_id = p_customer_id`. לאורח אין `customer_id`, ולכן לא בקשת מחיקה של אורח דרך יובל ולא מדיניות ה-24 חודשים נוגעות בו. אורחים הם רוב הלקוחות לפי ה-BRIEF.
- בקשה: לפצל ל-helpers שכל המסלולים קוראים להם (Rule 19, הגדרה אחת):
  - `fn_anonymize_order(p_order_id UUID) RETURNS BOOLEAN`: מאפס `guest_name`, `guest_phone`, `guest_email`, `delivery_address`, `delivery_notes`, ממלא `pii_purged_at`, מבטל את קישור האישור (B5). משאיר `delivery_city`, סכומים, סטטוס ותאריכים. אידמפוטנטי (`WHERE pii_purged_at IS NULL`).
  - `fn_anonymize_custom_cake_request(p_request_id UUID) RETURNS BOOLEAN`: מאפס `requester_name`, `requester_phone`, `requester_email`, `inscription_text`, `notes`, `decline_reason`, ממלא `pii_purged_at`. (דורש להפוך את `requester_name`/`requester_phone` ל-nullable, או CHECK בסגנון B1a.)
  - `fn_anonymize_customer` קוראת לשתיהן על כל ההזמנות והבקשות של הלקוח, ובנוסף כותבת אירוע `withdrawn` ל-`consent_events` אם `marketing_opt_in = true` (source חדש `account_deletion`, להוסיף ל-CHECK של `source`).
  - `fn_find_guest_records_by_phone(p_phone TEXT)`: admin בלבד (`is_admin_aal2()` בתוך הפונקציה), כדי שיובל תוכל לממש בקשת עיון או מחיקה של אורח (מפרט 6, "מצא לפי טלפון"). מחזיר רשימת הזמנות ובקשות עוגה.

**B1c. `custom_cake_requests` ו-`custom_cake_photos` לא מכוסים.** לא האנונימיזציה ולא כלל ה-30 יום לתמונות. בקשה שנדחתה לא הופכת אף פעם להזמנה, ולכן לעולם לא תנוקה דרך מסלול ההזמנות.
- בקשה, כי המחיקה מה-Storage נעשית דרך ה-API ולא ב-SQL (מפרט 6):
  - `fn_photos_due_for_purge() RETURNS TABLE (custom_cake_request_id UUID, storage_path TEXT)`: בקשות שבהן `photos_purged_at IS NULL` ו-(`status = 'declined'` ו-`updated_at` ישן מ-`photo_retention_days`, או שההזמנה המקושרת ב-`fulfilled`/`expired`/`cancelled` והזמן הסופי שלה ישן מ-`photo_retention_days`).
  - `fn_mark_photos_purged(p_request_id UUID)`: מוחקת את שורות `custom_cake_photos` וממלאת `photos_purged_at`. נקראת רק אחרי שה-Storage API אישר מחיקה (Rule 20: לא מסמנים מה שלא נמחק).
  - שתיהן `service_role` בלבד.

**B1d. `retention_until` לא מאוכלס בשום מקום, ואין פונקציה שבוחרת לפיו.** העמודה קיימת ב-`orders`, `custom_cake_requests` ו-`customers`, אבל אף פונקציה לא כותבת אותה ואף פונקציה לא קוראת אותה.
- בקשה: trigger על `orders` שמאכלס `retention_until` במעבר לסטטוס סופי: `COALESCE(fulfilled_at, expired_at, cancelled_at) + guest_pii_months`. אותו דבר ל-`custom_cake_requests` ב-`declined`.
- **המלצה לתקופה קצרה יותר להזמנה שלא הושלמה**: הזמנה שפגה או בוטלה לפני תשלום לא הפכה לעסקה, ושמירת כתובת וטלפון 24 חודשים בשבילה קשה להצדיק מול עקרון צמידות המטרה. מפתח חדש `unconsummated_order_pii_days`, ברירת מחדל 90. יובל ורו"ח מאשרים (מפרט 13 שאלה 1).
- `fn_retention_due() RETURNS TABLE (entity_type TEXT, entity_id UUID)` + `fn_run_retention_sweep() RETURNS JSONB` שמריצה את B1b על כל מה ש-`retention_until < now()` ומחזירה ספירה לכל סוג. `service_role` בלבד. אותו ג'וב יומי כמו `fn_purge_old_lookup_attempts` (לא ג'וב שני עם לוגיקה משלו).
- שורה ב-`cron_heartbeats` ל-`retention_sweep`, כדי שג'וב שמירה שנעצר ייראה, כמו job-001.

### B2. מחיקת חשבון רשום נכשלת בגלל `consent_events`

`consent_events.customer_id` מוגדר `REFERENCES customers(id) ON DELETE SET NULL`. ב-Postgres פעולת SET NULL של FK מבוצעת כ-UPDATE על השורה המפנה ומפעילה triggers מסוג `BEFORE UPDATE` ברמת שורה. `trg_consent_events_append_only` זורק שגיאה על כל UPDATE. התוצאה: מחיקת `auth.users` (שמפעילה CASCADE ל-`customers`) נכשלת לכל לקוח שיש לו אירוע הסכמה אחד, כלומר לכל מי שסימן או ביטל את ה-checkbox. זה שובר את `DELETE /api/me` של המפרט (סעיף 6).

**לשחזור אצל dba בקונטיינר:** ליצור customer, לקרוא ל-`fn_set_marketing_consent`, ואז `DELETE FROM customers WHERE id = ...`. צפוי: `append_only_table: UPDATE on consent_events is not permitted`.

- בקשה: להסיר את ה-FK ולהשאיר `customer_id UUID` רגיל עם הערה `-- evidence ref: kept after customer deletion`. זה גם מה שהמפרט ביקש: "נשאר מזהה + אימייל בלבד כראיה". ה-SET NULL הנוכחי היה מוחק את המזהה גם לו עבד.
- `privacy_requests.customer_id`: אין שם trigger, ולכן SET NULL עובד. המלצתי להסיר גם שם את ה-FK, מאותה סיבה ראייתית (רשומת הבקשה צריכה לשמור קשר ללקוח שביקש).
- סדר הפעולות במחיקה חייב להיות: `fn_anonymize_customer` קודם, מחיקת `auth.users` אחר כך. הזמנות אינן FK ל-`customers`, ולכן מחיקה בסדר הפוך משאירה כתובות על הזמנות של לקוח שכבר לא קיים. בקשה: `fn_hard_delete_customer(p_customer_id)` אחת שעושה את שני השלבים בסדר הנכון, ותיעוד ב-DB-PLAN כחוזה ל-jordan.
- `fn_customers_due_for_hard_delete()`: `deleted_at < now() - interval '7 days'`, עבור ה-sweep של חלון הטעות (מפרט 6).

### B3. ראיית ההסכמה ניתנת לזיוף

ס.30א דורש הסכמה של הנמען עצמו, והמפרט בונה את `consent_events` כהוכחה לה. בסכמה הנוכחית יש שתי דרכים לייצר ראיה כוזבת:

**B3a. `fn_set_marketing_consent` מקבלת `p_customer_id` מהקורא ומוענקת ל-`authenticated`, בלי שום בדיקה.** כל משתמש רשום יכול לרשום `granted` על שם כל לקוח אחר, עם `source` לבחירתו (כולל `admin_on_request`) וגרסה לבחירתו. בשלב 2 זה אדם שמקבל פרסומת בלי שהסכים, ובידי יובל רשומה שאומרת שכן.
- בקשה, בתוך הפונקציה:
  - `IF NOT (p_customer_id = auth.uid() OR is_admin_aal2() OR current_user = 'service_role') THEN RAISE EXCEPTION 'consent_not_own';`
  - `source = 'admin_on_request'` מותר רק כש-`is_admin_aal2()`. `source = 'unsubscribe_link'` רק מ-`service_role` (הנתיב הלא-מחובר של `/unsubscribe`), ורק עם `p_action = 'withdrawn'`.
  - `p_consent_version` חייב להיות שווה לערך הפעיל ב-`app_settings` בפעולת `granted` (אין הסכמה לנוסח שלא הוצג).
  - `fn_unsubscribe_by_token(p_token TEXT)` נפרדת ל-service_role, שמאתרת לפי `unsubscribe_token` ולא מקבלת `customer_id` בכלל.
  - בפעולת `withdrawn`: לאפס `birthday_*` ו-`anniversary_*` (מפרט 3: "נמחקים ברגע ביטול הסכמת השיווק, אין להם מטרה אחרת"). כרגע זה לא קורה.

**B3b. `GRANT UPDATE ON customers TO authenticated` על כל הטבלה.** מדיניות ה-RLS מאפשרת ללקוח לעדכן את השורה שלו, כלומר גם את `marketing_opt_in`, `marketing_consent_version`, `marketing_opt_in_at`, `age_confirmed_18_at`, `privacy_notice_version`, `retention_until`, `last_activity_at`, `unsubscribe_token`. ההערה בסכמה אומרת "only fn_set_marketing_consent may write this", וה-GRANT אומר אחרת. שער השליחה קורא מ-`consent_events` ולכן הנזק הישיר מוגבל, אבל `age_confirmed_18_at` ו-`privacy_notice_version` הן ראיות בפני עצמן.
- בקשה: `REVOKE UPDATE ON customers FROM authenticated;` ואז
  `GRANT UPDATE (name, phone, email, birthday_day, birthday_month, anniversary_day, anniversary_month) ON customers TO authenticated;`
  (עדכון admin נעשה דרך פונקציה או service_role, כמו שאר האדמין).

### B4. טלפון ו-IP נשמרים ללא הגבלת זמן

**B4a. `order_attempt_log`**: `ip_address` + `phone_e164` על כל ניסיון הזמנה, בלי purge ובלי מפתח שמירה. שימוש הטבלה הוא מגבלת קצב של שעה אחת (הבדיקה של "2 הזמנות פתוחות לטלפון" קוראת מ-`orders`, לא מהלוג).
- בקשה: `fn_purge_old_order_attempts() RETURNS INT` בתבנית של `fn_purge_old_lookup_attempts`, מפתח `order_attempts_retention_days` ברירת מחדל 30, `GRANT EXECUTE ... TO service_role`, באותו ג'וב יומי.

**B4b. `audit_log`**: `fn_create_standard_order` כותבת `fn_write_audit_log('system', p_ip_address, ...)`, כלומר IP גולמי ב-`actor_id` על כל הזמנה, בטבלה שה-trigger שלה אוסר DELETE לתמיד. זה מידע אישי שאין דרך טכנית למחוק, לא ב-sweep ולא לבקשה.
- בקשה: `actor_type = 'system'`, `actor_id = 'checkout:anon'` (או `'checkout:customer:' || p_customer_id` כשרשום). ה-IP כבר נמצא ב-`order_attempt_log` עם שמירה מוגדרת, ושם הוא צריך להיות.
- בנוסף (לא חוסם, אבל נחוץ לפני שנה ראשונה): מסלול שמירה ל-`audit_log`. הצעה: ה-trigger מתיר DELETE רק כש-`current_setting('app.retention_purge', true) = 'true'` ו-`OLD.created_at` ישן מ-`audit_log_retention_years`, דרך `fn_purge_old_audit_log()` של service_role. ברירת מחדל 7 שנים, לאישור רו"ח.

### B5. אישור ההזמנה (US-0c): השער ניתן לעקיפה והקישור לא ניתן לביטול

**B5a. `fn_record_order_confirmation_delivered` מוענקת ל-`authenticated` בלי שום בדיקת הרשאה.** כל לקוח רשום יכול לסמן כל הזמנה כ"אישור נמסר" עם נתיב PDF ו-hash לבחירתו, וכך לפתוח את שער ה-`fulfilled` שנבנה בדיוק כדי להבטיח את ס.14ג(ב). בנוסף הפונקציה מתועדת "נקראת פעם אחת" ובפועל דורסת נתיב, hash וקישור בכל קריאה, כך שה-hash כבר לא מוכיח שה-PDF שיוגש הוא זה שנשלח.
- בקשה:
  - `IF NOT (is_admin_aal2() OR current_user = 'service_role') THEN RAISE EXCEPTION ...;` (אימייל אוטומטי = service_role; WhatsApp ידני = יובל).
  - `WHERE id = p_order_id AND confirmation_delivered_at IS NULL`, והחזרת false בקריאה שנייה.

**B5b. ה-CHECK `confirmation_link_expires_at >= created_at + interval '24 months'` לא משאיר דרך לבטל קישור.** כשהזמנה עוברת אנונימיזציה (לבקשה, או בתום השמירה), הקישור ממשיך להגיש PDF עם פרטי הלקוח, וה-PDF נשאר ב-bucket.
- בקשה, עמודות חדשות ב-`orders`:
  - `confirmation_link_revoked_at TIMESTAMPTZ`
  - `confirmation_pdf_purged_at TIMESTAMPTZ`
- ה-CHECK הקיים נשאר (הרצפה נכונה), והנתיב שמגיש את הקישור בודק `confirmation_link_revoked_at IS NULL AND confirmation_pdf_purged_at IS NULL AND pii_purged_at IS NULL`.
- `fn_anonymize_order` (B1b) ממלאת `confirmation_link_revoked_at`. מחיקת הקובץ מה-Storage דרך ה-API, ואחריה `fn_mark_confirmation_pdf_purged(p_order_id)` (service_role). `fn_retention_due` מחזירה גם הזמנות עם `confirmation_pdf_path IS NOT NULL AND confirmation_pdf_purged_at IS NULL AND pii_purged_at IS NOT NULL`, כדי שקובץ שמחיקתו נכשלה ייתפס בריצה הבאה.
- `confirmation_pdf_sha256` נשאר אחרי המחיקה: זו ראיה שהמסמך נשלח, בלי תוכנו.

---

## 4. בקשות לא חוסמות (לפני PROD)

| # | טבלה / פונקציה | בקשה | למה |
|---|---|---|---|
| N1 | `customers` | `CHECK ((birthday_day IS NULL) = (birthday_month IS NULL))` ואותו דבר ל-anniversary | יום בלי חודש הוא נתון בלי מטרה |
| N2 | `customers` | `inactivity_notice_sent_at TIMESTAMPTZ` + `fn_customers_due_for_inactivity_notice()` + `fn_customers_due_for_inactivity_delete()` (36 חודשים, הודעה 30 יום מראש) | מפרט 3; לא דחוף כי האופק 36 חודשים, אבל בלי עמודה אין איך לתעד שההודעה נשלחה |
| N3 | `consent_events` | purge של `customer_email_snapshot` 7 שנים אחרי אירוע `withdrawn` אחרון (דרך אותו מסלול retention_purge כמו B4b), מפתח `consent_evidence_retention_years` | מפרט 3, התקופה לייעוץ משפטי |
| N4 | `privacy_requests` | `retention_until` מאוכלס ב-`completed_at + 3 years` + purge ב-sweep | מפרט 3 |
| N5 | `order_lookup_attempts`, `order_attempt_log` | לשמור `phone_hash` ו-`ip_hash` (sha256 עם pepper מהסביבה) במקום ערכים גולמיים. מגבלת קצב צריכה רק שוויון | צמצום נתונים; הטבלה שומרת גם טלפונים של צד שלישי שמישהו הקליד |
| N6 | `fn_purge_old_lookup_attempts` | `IF v_days IS NULL THEN RAISE EXCEPTION 'retention_setting_missing'` | היום מפתח חסר מוחק אפס שורות בשקט (Rule 20) |
| N7 | `fn_lookup_order_by_phone_and_number` | `AND o.pii_purged_at IS NULL` | סעיף 2 הערה 2 |
| N8 | `delivery_list_links` | לשנות שם ל-`token_hash`; `CHECK (expires_at <= ((delivery_date + 2)::timestamp AT TIME ZONE 'Asia/Jerusalem'))` | מפרט 7: סוף יום המשלוח + 24 שעות, נאכף בסכמה ולא רק באפליקציה |
| N9 | `delivery_list_links` (שלב 2) | כשייבנה, פונקציה אחת `fn_delivery_list_by_token(p_token)` שמחזירה רק שם, כתובת, טלפון, חלון זמן, הערות משלוח. בלי פריטים, מחירים, הקדשה | מפרט 7 ו-12. לשים לב: US-7 ב-PRD מתאר קישור כבר ב-MVP ו-SEC-016 אומר שלא. מאיה וארז מכריעים, לא אני |
| N10 | `custom_cake_photos` | `REVOKE DELETE ON custom_cake_photos FROM authenticated`; מחיקה רק דרך `fn_mark_photos_purged` | DELETE ישיר משאיר קובץ יתום ב-Storage |
| N11 | `app_settings` | trigger שאוכף רצפה ותקרה על מפתחות השמירה (למשל `guest_pii_months` בין 6 ל-84) | מפרט 6: "כדי שיובל לא תגדיר בטעות לנצח". באפליקציה בלבד זה נעקף ב-UPDATE ישיר, וה-GRANT קיים |
| N12 | `fn_anonymize_customer` | NULL במקום `'נמחק'` (אחרי תיקון ה-CHECK לפי B1a), והתצוגה מתרגמת דרך `he.json` | Rule 1: עברית קשיחה בקוד |
| N13 | `push_subscriptions` | מחיקת שורות עם `revoked_at` ישן מ-30 יום ב-sweep | מפרט 3: "עד ביטול או 410" |

---

## 5. מפתחות `app_settings` חסרים

| מפתח | ברירת מחדל | מקור |
|---|---|---|
| `order_attempts_retention_days` | 30 | B4a |
| `unconsummated_order_pii_days` | 90 | B1d, לאישור יובל/רו"ח |
| `audit_log_retention_years` | 7 | B4b, לאישור רו"ח |
| `consent_evidence_retention_years` | 7 | N3, לייעוץ משפטי |
| `privacy_requests_retention_years` | 3 | N4 |

---

## 6. לארז (לא ממצאי ציות, ראיתי בדרך)

1. **דפוס `p_admin_id` מהקורא.** `fn_mark_order_paid`, `fn_mark_order_fulfilled`, `fn_cancel_order`, `fn_approve_custom_cake_request`, `fn_decline_custom_cake_request`, `fn_admin_set_day_capacity` בודקות ש-`p_admin_id` קיים ב-`admins`, אבל הערך מגיע מהקורא וכולן מוענקות ל-`authenticated`. כל לקוח רשום שיודע את ה-UUID של יובל (הוא מופיע ב-`audit_log.actor_id` ובשדות `created_by`/`handled_by`) יכול לסמן הזמנה כשולמה או לבטל אותה. התיקון: `auth.uid()` בתוך הפונקציה במקום פרמטר, יחד עם `is_admin_aal2()`. ההערה בסוף קובץ הפונקציות ("a stolen JWT with the wrong role gets an exception") לא נכונה לדפוס הזה.
2. `p_ip_address` בפונקציות שמוענקות ל-anon (סעיף 2 הערה 3).
3. ב-`fn_create_standard_order` וב-`fn_lookup_order_by_phone_and_number` ה-INSERT ללוג וה-RAISE באותה טרנזקציה, כך שניסיון שנדחה מתגלגל אחורה ולא נרשם. הדחייה עצמה עובדת, אבל הראיה לא נשמרת. שווה החלטה מודעת.

---

## 7. סיכום לדיספצ'ר

- **חוסם:** B1 עד B5. כולם שינויים בקובץ הפונקציות ובכמה CHECK/GRANT, בסדר גודל של שעות עבודה ל-dba, לא ארכיטקטורה חדשה.
- **ההיגיון המשפטי של החסימה:** הודעת הפרטיות לפי ס.11 תתאר לציבור תקופת שמירה ומחיקה, וראיית ההסכמה לפי ס.30א היא מה שמגן על יובל בתביעת ספאם. בסכמה כפי שהיא, המחיקה נכשלת (B1a, B2), לא נוגעת ברוב הלקוחות (B1b, B1c), מידע אישי נשמר בלי מנגנון מחיקה (B4), וראיית ההסכמה ושער האישור בכתב ניתנים לזיוף מבחוץ (B3, B5a). אלה לא עניינים של סגנון.
- **לא חוסם אבל לפני PROD:** N1 עד N13.
- **נשאר לייעוץ משפטי, ללא שינוי:** האם PDF + קישור ב-WhatsApp מקיים את ס.14ג(ב), ותקופות השמירה (מפרט 13).
- **בדיקה חוזרת:** אחרי התיקון אני צריכה לראות את קובץ הפונקציות המעודכן, ותוצאת הרצה בקונטיינר של: מחיקת לקוח עם אירוע הסכמה (B2), אנונימיזציה של הזמנת משלוח של אורח (B1a/B1b), וקריאה ל-`fn_set_marketing_consent` על לקוח אחר שנדחית (B3a).

**פסק דין: BLOCK**

[[agents/rotem]] [[agents/erez]] [[agents/dba]] [[agents/jordan]] [[agents/maya]] [[yuval-bakery]] [[compliance-spec]] [[compliance-preconditions]]
