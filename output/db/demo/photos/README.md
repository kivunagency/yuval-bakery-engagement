# DEV demo product photos

Invented illustrations (marked DEMO) for the eight demo products of
`../dev-demo-data.sql`. DEV only; they go away with the demo data.

| File | Product id | Product |
|---|---|---|
| chocolate-cake.jpg | dddddddd-0000-0000-0001-000000000001 | עוגת שוקולד |
| croissant.jpg | dddddddd-0000-0000-0001-000000000002 | קרואסון חמאה |
| lemon-tart.jpg | dddddddd-0000-0000-0001-000000000003 | טארט לימון |
| apple-pie.jpg | dddddddd-0000-0000-0001-000000000004 | פאי תפוחים |
| butter-cookies.jpg | dddddddd-0000-0000-0001-000000000005 | עוגיות חמאה, קופסה של 12 |
| chocolate-babka.jpg | dddddddd-0000-0000-0001-000000000006 | בבקה שוקולד |
| macarons.jpg | dddddddd-0000-0000-0001-000000000007 | מקרונים, מארז 6 |
| cheesecake.jpg | dddddddd-0000-0000-0001-000000000008 | עוגת גבינה |

Upload: either through the admin product screen (`/admin/catalog/<id>`), or
from a machine that can reach `https://yvabibzpaplnraqqbowr.supabase.co`:
upload each file to the public bucket `product-photos` at `demo/<file>`, then
insert a `product_photos` row (`product_id`, `storage_path = 'demo/<file>'`,
`alt_text` = the product's `photo_alt`, `position = 0`). The wipe script
deletes the rows; delete the `demo/` objects in the bucket by hand.
