// Landing page: guided tour on first visit.
import { registerTours, startTour, whenLoaded } from './tour.js';

registerTours(
  {
    home: [
      { el: '.hero .btn.primary', title: '從這裡開始', text: '拍下或選一張活動導覽圖、樓層簡介圖，PhotoPath 會自動找出走道和地點，做成可以導航的 .phop 檔案。' },
      { el: '.hero .row .btn:not(.primary)', title: '開啟 .phop 檔案', text: '已經有 .phop 檔案（自己做的，或別人傳給你的），從這裡打開就能開始導航。' },
      { el: '.grid3', title: '不用 GPS 也能導航', text: '先選一個你附近的定位點當起點，之後只沿走道上、下、左、右移動，經過定位點就把誤差歸零。' },
      { el: '#tour-btn', title: '隨時重看導覽', text: '每一頁右上角都有「導覽」，忘記怎麼用的時候按一下就好。' },
    ],
  },
  () => 'home'
);
whenLoaded(() => startTour('home'));
