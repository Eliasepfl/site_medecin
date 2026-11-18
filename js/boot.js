// Chargé en premier : si un script du site ne démarre pas, on le dit au lieu de
// laisser une page qui ne réagit pas quand on dépose un fichier.
(function () {
  'use strict';
  var failed = [];
  function report() {
    var el = document.getElementById('status');
    if (!el || (window.FP && window.FP.ready)) return;
    el.textContent =
      "Le site n'a pas démarré" +
      (failed.length ? ' (fichier introuvable ou bloqué : ' + failed.join(', ') + ')' : '') +
      '. Rechargez la page avec Ctrl + F5. Si le problème persiste, essayez un autre navigateur.';
    el.className = 'status warn';
  }
  // Les erreurs de chargement de <script> ne remontent pas : il faut les capter.
  window.addEventListener(
    'error',
    function (e) {
      var t = e.target;
      if (t && t.tagName === 'SCRIPT' && t.src) failed.push(t.src.split('/').pop());
    },
    true
  );
  window.addEventListener('load', function () {
    setTimeout(report, 300);
  });
})();
