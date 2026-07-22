export class RegisterDto {
  constructor({ username, password, firstName, lastName, recoveryEmail, mobile }) {
    this.username = username;
    this.password = password;
    this.firstName = firstName;
    this.lastName = lastName;
    this.recoveryEmail = recoveryEmail;
    this.mobile = mobile;
  }
}
