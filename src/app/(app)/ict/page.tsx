import { redirect } from 'next/navigation';

/** The module opens on the user's own IT requests. */
export default function IctHome() {
  redirect('/ict/help');
}
