/**
 * Erro de aplicação com status HTTP e código estável.
 * A mensagem é sempre segura para mostrar ao usuário.
 */
export class AppError extends Error {
  readonly status: number;
  readonly codigo: string;
  readonly detalhes?: unknown;

  constructor(status: number, codigo: string, mensagem: string, detalhes?: unknown) {
    super(mensagem);
    this.name = "AppError";
    this.status = status;
    this.codigo = codigo;
    this.detalhes = detalhes;
  }

  static requisicaoInvalida(mensagem: string, detalhes?: unknown) {
    return new AppError(400, "requisicao_invalida", mensagem, detalhes);
  }

  static naoAutenticado(mensagem = "Sua sessão expirou. Entre de novo para continuar.") {
    return new AppError(401, "nao_autenticado", mensagem);
  }

  static semPermissao(mensagem = "Seu usuário não tem permissão para esta ação.") {
    return new AppError(403, "sem_permissao", mensagem);
  }

  static naoEncontrado(oQue: string) {
    return new AppError(404, "nao_encontrado", `${oQue} não foi encontrado.`);
  }

  static conflito(mensagem: string) {
    return new AppError(409, "conflito", mensagem);
  }

  static indisponivel(mensagem: string) {
    return new AppError(503, "indisponivel", mensagem);
  }
}

export const ehAppError = (erro: unknown): erro is AppError => erro instanceof AppError;
