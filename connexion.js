const authForm = document.getElementById("auth-form");
const authError = document.getElementById("auth-error");
const authSubmit = document.getElementById("auth-submit");
const roleOptions = document.querySelectorAll(".role-option");
const modeSwitch = document.getElementById("auth-mode-switch");
const confirmField = document.getElementById("confirm-field");
const confirmInput = document.getElementById("auth-confirm");
const adminNote = document.getElementById("auth-admin-note");
const formTitle = document.getElementById("form-title");
const formIntro = document.getElementById("form-intro");
let selectedRole = "user";
let isRegistering = false;

function renderAuthMode() {
  const isAdmin = selectedRole === "admin";
  roleOptions.forEach((option) => {
    const selected = option.dataset.role === selectedRole;
    option.classList.toggle("selected", selected);
    option.setAttribute("aria-pressed", String(selected));
  });
  if (isAdmin) isRegistering = false;
  confirmField.hidden = !isRegistering;
  confirmInput.required = isRegistering;
  document.getElementById("auth-password").autocomplete = isRegistering ? "new-password" : "current-password";
  modeSwitch.hidden = isAdmin;
  adminNote.hidden = !isAdmin;
  formTitle.textContent = isRegistering ? "Créer un compte" : isAdmin ? "Connexion administrateur" : "Bienvenue";
  formIntro.textContent = isRegistering
    ? "Créez un compte pour accéder aux observations du littoral."
    : isAdmin ? "Connectez-vous à votre espace d’administration."
      : "Connectez-vous pour accéder au tableau de bord.";
  authSubmit.textContent = isRegistering ? "Créer mon compte" : "Se connecter";
  modeSwitch.textContent = isRegistering ? "J’ai déjà un compte" : "Créer un compte utilisateur";
}

roleOptions.forEach((option) => {
  option.addEventListener("click", () => {
    selectedRole = option.dataset.role;
    authError.hidden = true;
    renderAuthMode();
  });
});

modeSwitch.addEventListener("click", () => {
  isRegistering = !isRegistering;
  authError.hidden = true;
  renderAuthMode();
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  authError.hidden = true;
  if (isRegistering && document.getElementById("auth-password").value !== confirmInput.value) {
    authError.textContent = "Les deux mots de passe ne correspondent pas.";
    authError.hidden = false;
    return;
  }
  authSubmit.disabled = true;
  try {
    const response = await fetch(isRegistering ? "/api/auth/register" : "/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: document.getElementById("auth-email").value,
        password: document.getElementById("auth-password").value,
        role: selectedRole
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Connexion impossible.");
    window.location.assign("/");
  } catch (error) {
    authError.textContent = error.message || "Le serveur est indisponible.";
    authError.hidden = false;
    authSubmit.disabled = false;
  }
});

fetch("/api/auth/me").then((response) => response.json()).then((session) => {
  if (session.user) window.location.replace("/");
}).catch(() => {});

renderAuthMode();