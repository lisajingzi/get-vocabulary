import { redirect } from "next/navigation";

/**
 * /login — deprecated.
 *
 * 登录功能已移除（私有部署 + 个人使用）。任何指向 /login 的旧链接都会
 * 直接重定向回首页，避免 404。等你确认没问题后，可以把整个 login 目录删掉。
 */
export default function LoginPage() {
  redirect("/");
}
