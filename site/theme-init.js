// Aplica o tema salvo (claro/escuro) antes de desenhar a página, para não piscar.
// O padrão é o escuro, que combina com a identidade da barbearia.
function initTheme() {
  try {
    const saved = localStorage.getItem('hanoff-theme');
    document.documentElement.dataset.theme = saved === 'light' ? 'light' : 'dark';
  } catch {
    document.documentElement.dataset.theme = 'dark';
  }
}

initTheme();

// Outra aba mudou o tema
window.addEventListener('storage', (e) => {
  if (e.key === 'hanoff-theme' && e.newValue) document.documentElement.dataset.theme = e.newValue === 'light' ? 'light' : 'dark';
});

export { initTheme };
