function hasFileExtension(uri) {
  return uri.lastIndexOf(".") > uri.lastIndexOf("/");
}

function rewriteToShell(uri) {
  if (uri === "" || uri === "/") {
    return "/index.html";
  }

  if (uri === "/setup" || uri === "/setup/") {
    return "/setup/index.html";
  }

  if (uri === "/sign-in" || uri === "/sign-in/") {
    return "/sign-in/index.html";
  }

  if (uri === "/auth/callback" || uri === "/auth/callback/") {
    return "/auth/callback/index.html";
  }

  if (uri === "/ui/components" || uri === "/ui/components/") {
    return "/ui/components/index.html";
  }

  if (uri === "/leagues" || uri.indexOf("/leagues/") === 0) {
    return "/leagues/index.html";
  }

  if (uri === "/seasons" || uri.indexOf("/seasons/") === 0) {
    return "/seasons/index.html";
  }

  if (uri === "/games" || uri.indexOf("/games/") === 0) {
    return "/games/index.html";
  }

  return uri;
}

function handler(event) {
  var request = event.request;
  var uri = request.uri || "/";

  if (hasFileExtension(uri)) {
    return request;
  }

  request.uri = rewriteToShell(uri);
  return request;
}
