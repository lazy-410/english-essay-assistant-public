// 授权公钥（SPKI PEM）。
// 本文件默认是「开发/测试公钥」，与 scripts/keys/test-private.pem 对应，仅供回归测试。
// 发行构建（scripts/build-protected.mjs --license-key <作者私钥>）会临时把本文件
// 覆盖为作者公钥后打包，构建结束随即还原 —— 作者私钥永远不进入项目目录与发行包。
export const LICENSE_PUBKEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA3VA2aCAaY7Gt9jhjNu5ZnAMjGdFKq1g35aNFiGCBeEM=
-----END PUBLIC KEY-----`;
