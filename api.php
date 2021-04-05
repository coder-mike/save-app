<?php

require_once "config.php";

mysqli_report(MYSQLI_REPORT_ALL);

$link = mysqli_connect(DB_SERVER, DB_USERNAME, DB_PASSWORD, DB_NAME);

$req = json_decode(file_get_contents('php://input'), true);

$res = array('success' => false, 'reason' => 'Unknown reason');

if ($req['cmd'] == 'new-account') {
  newAccount();
} else if ($req['cmd'] == 'login') {
  login();
} else if ($req['cmd'] == 'save') {
  save();
} else if ($req['cmd'] == 'load') {
  load();
} else {
  errorResponse('Unknown command');
}

header('Content-Type: application/json');
echo json_encode($res);
mysqli_close($link);

function logError($err) {
  error_log($err);
  // echo $err;
}

function errorResponse($reason) {
  global $res;
  $res = array('success' => false, 'reason' => $reason);
}

function newAccount() {
  global $res;
  global $req;
  global $link;

  $data = $req['data'];
  $name = $data['name'];
  $email = $data['email'];
  $state = json_encode($data['state']);
  $password_hash = password_hash($data['password'], PASSWORD_DEFAULT);

  $stmt = mysqli_prepare($link, "SELECT id FROM users WHERE email = ?");
  if (!$stmt) {
    logError('newAccount: failed to prepare SQL statement to fetch user');
    return;
  }

  mysqli_stmt_bind_param($stmt, "s", $email);
  if (!mysqli_stmt_execute($stmt)) {
    logError('newAccount: failed to bind params to fetch user');
    mysqli_stmt_close($stmt);
    return;
  }

  mysqli_stmt_store_result($stmt);
  if (mysqli_stmt_num_rows($stmt) >= 1) {
    errorResponse('An existing account is associated with this email address');
    mysqli_stmt_close($stmt);
    return;
  }

  mysqli_stmt_close($stmt);

  $stmt = mysqli_prepare($link, "INSERT INTO users (id, name, email, password, state) VALUES (UUID(), ?, ?, ?, ?)");
  if (!$stmt) {
    logError('newAccount: failed to prepare SQL statement to insert new user');
    return;
  }
  mysqli_stmt_bind_param($stmt, "ssss", $name, $email, $password_hash, $state);
  if (!mysqli_stmt_execute($stmt)) {
    logError('newAccount: failed to execute SQL statement to insert new user');
    return;
  }
  mysqli_stmt_close($stmt);

  login();
}

function login() {
  global $res;
  global $req;
  global $link;

  $data = $req['data'];
  $email = $data['email'];
  $password = $data['password'];

  $stmt = mysqli_prepare($link, "SELECT HEX(id) as id, name, password, state FROM users WHERE email = ?");
  if (!$stmt) {
    logError('login: failed to prepare SQL statement to select user');
    return;
  }

  mysqli_stmt_bind_param($stmt, "s", $email);
  if (!mysqli_stmt_execute($stmt)) {
    logError('login: failed to execute SQL to select user');
    mysqli_stmt_close($stmt);
    return;
  }

  mysqli_stmt_store_result($stmt);
  if (mysqli_stmt_num_rows($stmt) != 1) {
    errorResponse('User not found');
    mysqli_stmt_close($stmt);
    return;
  }

  mysqli_stmt_bind_result($stmt, $userId, $name, $hashed_password, $state);
  mysqli_stmt_fetch($stmt); // Fetch first row

  if (!password_verify($password, $hashed_password)) {
    errorResponse('Invalid username or password');
    mysqli_stmt_close($stmt);
    return;
  }

  $res = array(
    'success' => true,
    'state' => json_decode($state),
    'userInfo' => array(
      'id' => $userId,
      'name' => $name,
      'email' => $email,
    )
  );

  mysqli_stmt_close($stmt);
}

function save() {
  global $res;
  global $req;
  global $link;

  $data = $req['data'];
  $userId = $data['userId'];
  $state = json_encode($data['state']);

  $stmt = mysqli_prepare($link, 'UPDATE users set state = ? WHERE id = (UNHEX(REPLACE(?, "-","")))');
  if (!$stmt) {
    logError('save: failed to prepare SQL statement to update user');
    return;
  }
  mysqli_stmt_bind_param($stmt, "ss", $state, $userId);
  if (!mysqli_stmt_execute($stmt)) {
    logError('save: failed to execute statement to update user');
    return;
  }

  $res = array(
    'success' => true
  );

  mysqli_stmt_close($stmt);
}

function load() {
  global $res;
  global $req;
  global $link;

  $data = $req['data'];
  $userId = $data['userId'];

  $stmt = mysqli_prepare($link, 'SELECT HEX(id) as id, name, email, state FROM users WHERE id = (UNHEX(REPLACE(?, "-","")))');
  if (!$stmt) {
    logError('load: failed to prepare SQL statement');
    return;
  }
  mysqli_stmt_bind_param($stmt, "s", $userId);
  if (!mysqli_stmt_execute($stmt)) {
    logError('load: failed to execute SQL statement');
    mysqli_stmt_close($stmt);
    return;
  }

  mysqli_stmt_store_result($stmt);
  if (mysqli_stmt_num_rows($stmt) != 1) {
    errorResponse('User not found');
    mysqli_stmt_close($stmt);
    return;
  }

  mysqli_stmt_bind_result($stmt, $userId, $name, $email, $state);
  mysqli_stmt_fetch($stmt); // Fetch first row

  $res = array(
    'success' => true,
    'state' => json_decode($state),
    'userInfo' => array(
      'id' => $userId,
      'name' => $name,
      'email' => $email,
    )
  );

  mysqli_stmt_close($stmt);
}