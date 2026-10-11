// ===== 家人名單 =====

// 家人名單：parent: true 可以答應願望、排月曆；editor: true 可以新增、編輯、匯入食譜
// icon 是 Lucide 圖示名稱（清單在 icons.js），color 是頭像顏色
const FAMILY = [
  { id: "Dad",   email: "archie@ourfamily.home",  parent: true, name: "Dad",   icon: "rabbit", color: "#3c78d8" },
  { id: "Mom",   email: "jocelyn@ourfamily.home", parent: true, editor: true, name: "Mom",   icon: "rabbit", color: "#e06666" },
  { id: "Ethan", email: "ethan@ourfamily.home",   name: "Ethan", icon: "face-grinning", color: "#f1c232" },
  { id: "Rosie", email: "rosie@ourfamily.home",   name: "Rosie", icon: "cat", color: "#8e7cc3" },
  { id: "Heng",  email: "heng@ourfamily.home",    name: "Heng",  icon: "plane", color: "#6aa84f" },
];

// ===== 分類標籤 =====
const TAG_GROUPS = [
  { name: "類型", tags: ["豬肉", "牛肉", "雞肉","海鮮","蔬食"] },
  { name: "料理", tags: ["中式","西式", "日式","韓式","泰式"] },
  { name: "其他", tags: ["麵食","早餐","點心","湯品","主餐"] },
];

// ===== 食譜 =====
// image：可留空（強烈建議放照片，版面以照片為主）。要放照片就把照片放進 images 資料夾，寫 "images/檔名.jpg"
// steps：每一步可以是文字，或 { text: "說明", image: "images/xxx.jpg" } 讓步驟附照片
// 食譜的 icon 也是 Lucide 圖示名稱；顏色依標籤自動決定，想指定可加 color: "#色碼"
const RECIPES = [];
