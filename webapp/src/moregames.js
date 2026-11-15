// «More games»: одна кнопка на страницу разработчика в App Store — там все наши
// приложения (Grow Sell, Mine Sell, Rug Reveal, Puzzles и будущие). Конкретные
// игры не перечисляем: список держит App Store. Такой раздел — во всех наших
// приложениях. Награду за установку других приложений не давать (правила Apple).

import { PLATFORM, openLink } from "./platform.js";

const DEVELOPER_ID = "6802653926"; // Vladislav Markov в App Store
const WEB_URL = `https://apps.apple.com/us/developer/vladislav-markov/id${DEVELOPER_ID}`;
const STORE_URL = `itms-apps://apps.apple.com/developer/id${DEVELOPER_ID}`; // сразу в приложение App Store

export function openMoreGames() {
  // На iOS не через openLink: SFSafariViewController не открывает itms-apps,
  // а незнакомую схему из WebView Capacitor отдаёт системе — откроется App Store.
  if (PLATFORM === "ios") window.location.href = STORE_URL;
  else openLink(WEB_URL); // Telegram и браузер: страница App Store
}
