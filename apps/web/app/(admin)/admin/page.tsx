import { redirect } from 'next/navigation';
import { requireAdminPage } from '@/lib/server/auth/admin';

export default async function AdminHome() {
  await requireAdminPage();
  redirect('/admin/orders');
}
