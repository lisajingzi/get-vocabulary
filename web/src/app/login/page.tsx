/**
 * /login — email magic-link login (Day 7).
 *
 * Day 7 wires this to Supabase Auth with a single-email whitelist
 * (NEXT_PUBLIC_ALLOWED_EMAIL). For Day 1 we only need the placeholder route.
 */
export default function LoginPage() {
  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">登录</h1>
      <p className="text-sm text-[var(--fg-soft)]">
        🚧 Day 7 将接入 Supabase Auth 邮箱登录（仅白名单邮箱可访问）。
      </p>
    </div>
  );
}
