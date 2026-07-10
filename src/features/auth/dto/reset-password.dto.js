export class ResetPasswordDto {
  constructor({ token, password }) {
    this.token = token;
    this.password = password;
  }
}
