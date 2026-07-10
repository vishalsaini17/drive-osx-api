export class RegisterDto {
  constructor({ username, password, fullName, recoveryEmail, mobile }) {
    this.username = username;
    this.password = password;
    this.fullName = fullName;
    this.recoveryEmail = recoveryEmail;
    this.mobile = mobile;
  }
}
