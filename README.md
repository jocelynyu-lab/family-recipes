# 我們家的食譜

給孩子瀏覽的家庭食譜網站，可以搜尋、分類，並讓每位家人幫菜色打 1～5 顆星。純靜態網頁，直接放在 GitHub Pages 就能用。

## 檔案說明

| 檔案 | 用途 |
|---|---|
| `index.html` | 網頁本體 |
| `style.css` | 樣式 |
| `app.js` | 程式邏輯（一般不用改） |
| `recipes.js` | **家人名單與食譜內容，平常只需要改這個** |
| `config.js` | 選用：Firebase 設定（讓評分全家同步） |
| `images/` | 選用：放食譜照片 |

## 一、放上 GitHub Pages

1. 在 GitHub 建立新的 repository，例如 `family-recipes`（設為 Public；免費帳號的 Pages 需要 Public）。
2. 點 **Add file → Upload files**，把這個資料夾裡的所有檔案拖進去，按 **Commit changes**。
3. 到 **Settings → Pages**，Source 選 **Deploy from a branch**，Branch 選 `main`、資料夾 `/ (root)`，按 Save。
4. 等 1～2 分鐘，網址會是 `https://你的帳號.github.io/family-recipes/`。

## 二、新增或修改食譜

打開 `recipes.js`，複製一整段 `{ ... },` 貼到最後再改內容。注意：

- `id` 只用英文、數字、連字號，不要重複，建立後不要再改（評分是跟著 id 存的）。
- `level`：1 = 簡單、2 = 要一點耐心、3 = 請大人一起做。
- 要放照片：把照片放進 `images/`，寫 `image: "images/tomato-egg.jpg"`。照片建議先縮到寬 1200px 以內。
- 每道菜的網址可以直接分享，例如 `.../family-recipes/#tomato-egg`。

家人名單在同一個檔案最上面的 `FAMILY`，名字和 emoji 可以隨意改。

## 三、評分怎麼存？

**預設（不用設定）**：評分存在瀏覽器裡。缺點是只有同一台裝置看得到，換手機或清除瀏覽資料就不見了。

**全家同步（建議）**：用 Google 的 Firebase 免費方案，家裡每個人在不同裝置上都能看到同一份評分，而且會即時更新。

1. 到 <https://console.firebase.google.com> 建立專案（Google Analytics 可關掉）。
2. 左側 **Build → Firestore Database → Create database**，地區選 `asia-east1`（台灣），先選 production mode。
3. 在 **Rules** 分頁貼上下面規則後按 Publish（把清單換成你在 `FAMILY` 裡用的 id）：

   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /ratings/{recipeId} {
         allow read: if true;
         allow write: if request.resource.data.keys().hasOnly(['dad', 'mom', 'kid1', 'kid2']);
       }
     }
   }
   ```

4. 回到專案首頁，點 **</>（Web）** 新增網頁應用程式，會看到一段 `firebaseConfig`。把 `apiKey`、`authDomain`、`projectId`、`appId` 四個值貼到 `config.js`。
5. 上傳更新後的 `config.js` 到 GitHub。頁面底部顯示「評分會同步給全家人。」就成功了。

> Firebase 的 apiKey 放在公開網頁上是正常做法，它只用來識別專案。真正控制誰能寫入的是上面的規則。因為沒有登入功能，知道網址的人理論上可以改評分；家庭使用通常沒問題，若在意可以之後再加上 Firebase Authentication。

## 在自己電腦預覽

直接雙擊 `index.html` 就能打開。
