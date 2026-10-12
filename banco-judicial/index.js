require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
} = require("discord.js");

const Database = require("better-sqlite3");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const AUDIT_CHANNEL_ID = process.env.AUDIT_CHANNEL_ID;

const PAY_ROLE_IDS = (process.env.PAY_ROLE_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  throw new Error(
    "Configure DISCORD_TOKEN, CLIENT_ID e GUILD_ID no .env"
  );
}

const SALDO_INICIAL = 1000;
const TESOURO = "TESOURO";
const LIMITE = 1_000_000;

const db = new Database("banco.db");
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS contas (
    usuario_id TEXT PRIMARY KEY,
    saldo INTEGER NOT NULL CHECK (saldo >= 0)
  );

  CREATE TABLE IF NOT EXISTS transacoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    origem TEXT,
    destino TEXT,
    valor INTEGER NOT NULL CHECK (valor > 0),
    tipo TEXT NOT NULL,
    motivo TEXT NOT NULL,
    operador TEXT,
    data TEXT NOT NULL
  );
`);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ==================================================
// FUNÇÕES DO BANCO
// ==================================================

function saldoDe(id) {
  return db.prepare(
    "SELECT saldo FROM contas WHERE usuario_id = ?"
  ).get(String(id))?.saldo;
}

function registrar(origem, destino, valor, tipo, motivo, operador) {
  db.prepare(`
    INSERT INTO transacoes
      (origem, destino, valor, tipo, motivo, operador, data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    origem == null ? null : String(origem),
    destino == null ? null : String(destino),
    valor,
    tipo,
    motivo,
    operador == null ? null : String(operador),
    new Date().toISOString()
  );
}

function garantirConta(id) {
  id = String(id);

  if (saldoDe(id) !== undefined) return;

  db.prepare(
    "INSERT INTO contas (usuario_id, saldo) VALUES (?, ?)"
  ).run(id, id === TESOURO ? 0 : SALDO_INICIAL);

  if (id !== TESOURO) {
    registrar(
      null,
      id,
      SALDO_INICIAL,
      "saldo_inicial",
      "Criação da carteira",
      null
    );
  }
}

function transacao(callback) {
  return db.transaction(callback)();
}

// ==================================================
// AUDITORIA E PERMISSÕES
// ==================================================

async function auditar(mensagem) {
  if (!AUDIT_CHANNEL_ID) {
    console.error(
      "AUDIT_CHANNEL_ID não está configurado no .env"
    );
    return;
  }

  try {
    const canal = await client.channels.fetch(AUDIT_CHANNEL_ID);

    if (!canal || !canal.isTextBased() || !canal.send) {
      console.error(
        "Canal de auditoria inválido ou sem suporte a mensagens."
      );
      return;
    }

    const conteudo =
      typeof mensagem === "string"
        ? { content: mensagem }
        : mensagem;

    await canal.send({
      ...conteudo,
      allowedMentions: { parse: [] },
    });
  } catch (erro) {
    console.error(
      "Falha ao registrar no canal de auditoria:",
      erro
    );
  }
}

async function temCargoAutorizado(interaction) {
  if (PAY_ROLE_IDS.length === 0 || !interaction.guild) {
    return false;
  }

  const membro = await interaction.guild.members.fetch(
    interaction.user.id
  );

  return PAY_ROLE_IDS.some((id) =>
    membro.roles.cache.has(id)
  );
}

function ehAdmin(interaction) {
  return (
    interaction.memberPermissions?.has(
      PermissionFlagsBits.Administrator
    ) ?? false
  );
}

async function responder(interaction, texto) {
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp({
      content: texto,
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  }

  return interaction.reply({
    content: texto,
    ephemeral: true,
    allowedMentions: { parse: [] },
  });
}

function comando(nome, descricao) {
  return new SlashCommandBuilder()
    .setName(nome)
    .setDescription(descricao);
}

function formatarCreditos(valor) {
  return `${(valor || 0).toLocaleString("pt-BR")} créditos`;
}

function formatarData(data) {
  return new Date(data).toLocaleString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ==================================================
// DEFINIÇÃO DOS COMANDOS
// ==================================================

const comandos = [
  comando(
    "saldo_tesouro",
    "Consultar o saldo do Tesouro Judicial"
  ).setDefaultMemberPermissions(
    PermissionFlagsBits.Administrator
  ),

  comando(
    "consultar_saldo",
    "Consultar o saldo de qualquer membro"
  )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    )
    .addUserOption((o) =>
      o
        .setName("membro")
        .setDescription("Membro que terá o saldo consultado")
        .setRequired(true)
    ),

  comando("saldo", "Consultar sua carteira"),

  comando("extrato", "Ver suas últimas movimentações"),

  comando(
    "consultar_extrato",
    "Consultar o extrato de um membro"
  )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    )
    .addUserOption((o) =>
      o
        .setName("membro")
        .setDescription("Membro cujo extrato será consultado")
        .setRequired(true)
    ),

  comando(
    "pagar",
    "Transferir créditos para um membro"
  )
    .addUserOption((o) =>
      o
        .setName("membro")
        .setDescription("Destinatário")
        .setRequired(true)
    )
    .addIntegerOption((o) =>
      o
        .setName("valor")
        .setDescription("Valor em créditos")
        .setMinValue(1)
        .setMaxValue(LIMITE)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("motivo")
        .setDescription("Motivo do pagamento")
        .setMaxLength(150)
        .setRequired(true)
    ),

  comando("creditar", "Conceder créditos a um membro")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    )
    .addUserOption((o) =>
      o
        .setName("membro")
        .setDescription("Destinatário")
        .setRequired(true)
    )
    .addIntegerOption((o) =>
      o
        .setName("valor")
        .setDescription("Valor")
        .setMinValue(1)
        .setMaxValue(LIMITE)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("motivo")
        .setDescription("Justificativa")
        .setMaxLength(150)
        .setRequired(true)
    ),

  comando(
    "debitar",
    "Retirar créditos de um membro e enviar ao tesouro"
  )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    )
    .addUserOption((o) =>
      o
        .setName("membro")
        .setDescription("Membro que será debitado")
        .setRequired(true)
    )
    .addIntegerOption((o) =>
      o
        .setName("valor")
        .setDescription("Valor a retirar")
        .setMinValue(1)
        .setMaxValue(LIMITE)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("motivo")
        .setDescription("Justificativa da retirada")
        .setMaxLength(150)
        .setRequired(true)
    ),

  comando(
    "financiar_tesouro",
    "Adicionar créditos ao tesouro"
  )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    )
    .addIntegerOption((o) =>
      o
        .setName("valor")
        .setDescription("Valor")
        .setMinValue(1)
        .setMaxValue(LIMITE)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("motivo")
        .setDescription("Justificativa")
        .setMaxLength(150)
        .setRequired(true)
    ),

  comando("salario", "Pagar salário usando o tesouro")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    )
    .addUserOption((o) =>
      o
        .setName("membro")
        .setDescription("Funcionário")
        .setRequired(true)
    )
    .addIntegerOption((o) =>
      o
        .setName("valor")
        .setDescription("Salário")
        .setMinValue(1)
        .setMaxValue(LIMITE)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("motivo")
        .setDescription("Cargo e período")
        .setMaxLength(150)
        .setRequired(true)
    ),

  comando("multa", "Aplicar multa fictícia")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    )
    .addUserOption((o) =>
      o
        .setName("membro")
        .setDescription("Pessoa multada")
        .setRequired(true)
    )
    .addIntegerOption((o) =>
      o
        .setName("valor")
        .setDescription("Valor da multa")
        .setMinValue(1)
        .setMaxValue(LIMITE)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("motivo")
        .setDescription("Fundamento da multa no roleplay")
        .setMaxLength(150)
        .setRequired(true)
    ),

  comando("imposto", "Cobrar imposto fictício")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    )
    .addUserOption((o) =>
      o
        .setName("membro")
        .setDescription("Contribuinte")
        .setRequired(true)
    )
    .addIntegerOption((o) =>
      o
        .setName("valor")
        .setDescription("Valor do imposto")
        .setMinValue(1)
        .setMaxValue(LIMITE)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("motivo")
        .setDescription("Motivo da cobrança")
        .setMaxLength(150)
        .setRequired(true)
    ),

  comando(
    "auditoria",
    "Consultar o histórico financeiro"
  )
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    )
    .addUserOption((o) =>
      o
        .setName("membro")
        .setDescription("Filtrar por membro")
        .setRequired(false)
    )
    .addStringOption((o) =>
      o
        .setName("tipo")
        .setDescription("Filtrar por tipo de operação")
        .setRequired(false)
        .addChoices(
          { name: "Transferência", value: "transferencia" },
          { name: "Pagamento antigo", value: "honorarios" },
          { name: "Outro pagamento", value: "outro" },
          {
            name: "Crédito administrativo",
            value: "credito_administrativo",
          },
          {
            name: "Débito administrativo",
            value: "debito_administrativo",
          },
          {
            name: "Financiamento do tesouro",
            value: "financiamento_tesouro",
          },
          { name: "Saldo inicial", value: "saldo_inicial" },
          { name: "Salário", value: "salario" },
          { name: "Multa", value: "multa" },
          { name: "Imposto", value: "imposto" }
        )
    )
    .addIntegerOption((o) =>
      o
        .setName("pagina")
        .setDescription("Número da página")
        .setMinValue(1)
        .setRequired(false)
    ),

    
  comando("aviso", "Publicar um aviso oficial")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    )
    .addChannelOption((o) =>
      o
        .setName("canal")
        .setDescription("Canal em que o aviso será publicado")
        .addChannelTypes(0)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("titulo")
        .setDescription("Título do aviso")
        .setMaxLength(200)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("mensagem")
        .setDescription("Conteúdo do aviso")
        .setMaxLength(3500)
        .setRequired(true)
    ),
];

// ==================================================
// MANIPULADORES DOS COMANDOS
// ==================================================

const handlers = {
  async consultar_saldo(i) {
    if (!ehAdmin(i)) {
      return responder(
        i,
        "❌ Apenas administradores podem consultar saldos."
      );
    }

    const usuario = i.options.getUser("membro");

    if (usuario.bot) {
      return responder(
        i,
        "❌ Selecione um membro válido, não um bot."
      );
    }

    const saldo = transacao(() => {
      garantirConta(usuario.id);
      return saldoDe(usuario.id);
    });

    const embed = new EmbedBuilder()
      .setColor(0x1F4E79)
      .setTitle("🏛️ CONSULTA DE SALDO")
      .setDescription(
        `**Titular:** ${usuario}\n` +
        `**ID:** \`${usuario.id}\`\n\n` +
        `### 💰 Saldo atual\n` +
        `**${formatarCreditos(saldo)}**`
      )
      .setFooter({
        text: "Banco Judicial • Consulta administrativa",
      })
      .setTimestamp();

    return i.reply({
      embeds: [embed],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  },

  async saldo_tesouro(i) {
    if (!ehAdmin(i)) {
      return responder(i, "❌ Sem permissão.");
    }

    const saldo = transacao(() => {
      garantirConta(TESOURO);
      return saldoDe(TESOURO);
    });

    return responder(
      i,
      `🏛️ Saldo do Tesouro Judicial: **${formatarCreditos(saldo)}**.`
    );
  },

  async saldo(i) {
    const valor = transacao(() => {
      garantirConta(i.user.id);
      return saldoDe(i.user.id);
    });

    return responder(
      i,
      `💰 Seu saldo: **${formatarCreditos(valor)}**.`
    );
  },

  async extrato(i) {
    const dados = transacao(() => {
      garantirConta(i.user.id);

      const saldo = saldoDe(i.user.id);

      const linhas = db.prepare(`
        SELECT *
        FROM transacoes
        WHERE origem = ? OR destino = ?
        ORDER BY id DESC
        LIMIT 10
      `).all(i.user.id, i.user.id);

      const totais = db.prepare(`
        SELECT
          COALESCE(
            SUM(CASE WHEN destino = ? THEN valor ELSE 0 END), 0
          ) AS entradas,
          COALESCE(
            SUM(CASE WHEN origem = ? THEN valor ELSE 0 END), 0
          ) AS saidas
        FROM transacoes
        WHERE origem = ? OR destino = ?
      `).get(
        i.user.id,
        i.user.id,
        i.user.id,
        i.user.id
      );

      return { saldo, linhas, totais };
    });

    const historico = dados.linhas.length
      ? dados.linhas.map((t) => {
          const entrada = t.destino === i.user.id;
          const sinal = entrada ? "+" : "−";
          const icone = entrada ? "📥" : "📤";

          return (
            `${icone} **#${t.id} — ${t.tipo.replace(/_/g, " ").toUpperCase()}**\n` +
            `　${sinal}${formatarCreditos(t.valor)}\n` +
            `　📝 ${(t.motivo || "Não informado").slice(0, 120)}\n` +
            `　📅 ${formatarData(t.data)}`
          );
        }).join("\n\n")
      : "Nenhuma movimentação registrada.";

    const embed = new EmbedBuilder()
      .setColor(0x1F4E79)
      .setAuthor({
        name: "TRIBUNAL VIRTUAL • BANCO JUDICIAL",
      })
      .setTitle("📜 EXTRATO DE MOVIMENTAÇÕES")
      .setDescription(
        `**Titular:** ${i.user}\n` +
        `**Identificação:** \`${i.user.id}\`\n\n` +
        `## 💰 Saldo disponível\n` +
        `# ${formatarCreditos(dados.saldo)}`
      )
      .addFields(
        {
          name: "📥 Total de entradas",
          value: formatarCreditos(dados.totais.entradas),
          inline: true,
        },
        {
          name: "📤 Total de saídas",
          value: formatarCreditos(dados.totais.saidas),
          inline: true,
        },
        {
          name: "📚 Histórico recente",
          value: historico.slice(0, 1024),
          inline: false,
        }
      )
      .setFooter({
        text: "Documento financeiro • Banco Judicial",
      })
      .setTimestamp();

    return i.reply({
      embeds: [embed],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  },

  async consultar_extrato(i) {
    if (!ehAdmin(i)) {
      return responder(
        i,
        "❌ Apenas administradores podem consultar extratos."
      );
    }

    const usuario = i.options.getUser("membro");

    if (usuario.bot) {
      return responder(
        i,
        "❌ Selecione um membro, não um bot."
      );
    }

    const dados = {
      saldo: saldoDe(usuario.id) ?? 0,

      linhas: db.prepare(`
        SELECT *
        FROM transacoes
        WHERE origem = ? OR destino = ?
        ORDER BY id DESC
        LIMIT 10
      `).all(usuario.id, usuario.id),

      totais: db.prepare(`
        SELECT
          COALESCE(
            SUM(CASE WHEN destino = ? THEN valor ELSE 0 END), 0
          ) AS entradas,
          COALESCE(
            SUM(CASE WHEN origem = ? THEN valor ELSE 0 END), 0
          ) AS saidas
        FROM transacoes
        WHERE origem = ? OR destino = ?
      `).get(
        usuario.id,
        usuario.id,
        usuario.id,
        usuario.id
      ),
    };

    const historico = dados.linhas.length
      ? dados.linhas.map((t) => {
          const entrada = t.destino === usuario.id;
          const icone = entrada ? "📥" : "📤";
          const sinal = entrada ? "+" : "−";

          return (
            `${icone} **#${t.id} • ${t.tipo.replace(/_/g, " ").toUpperCase()}**\n` +
            `　${sinal}${formatarCreditos(t.valor)}\n` +
            `　📝 ${(t.motivo || "Não informado").slice(0, 120)}\n` +
            `　📅 ${formatarData(t.data)}`
          );
        }).join("\n\n")
      : "Nenhuma movimentação registrada para este membro.";

    const embed = new EmbedBuilder()
      .setColor(0x1F4E79)
      .setAuthor({
        name: "TRIBUNAL VIRTUAL • BANCO JUDICIAL",
      })
      .setTitle("🔎 EXTRATO FINANCEIRO ADMINISTRATIVO")
      .setDescription(
        `**Titular:** ${usuario}\n` +
        `**ID:** \`${usuario.id}\`\n\n` +
        `## 💰 Saldo atual\n` +
        `# ${formatarCreditos(dados.saldo)}`
      )
      .addFields(
        {
          name: "📥 Total de entradas",
          value: formatarCreditos(dados.totais.entradas),
          inline: true,
        },
        {
          name: "📤 Total de saídas",
          value: formatarCreditos(dados.totais.saidas),
          inline: true,
        },
        {
          name: "📚 Últimas movimentações",
          value: historico.slice(0, 1024),
          inline: false,
        },
        {
          name: "👮 Responsável pela consulta",
          value: `${i.user}`,
          inline: false,
        }
      )
      .setFooter({
        text: "Banco Judicial • Consulta restrita à administração",
      })
      .setTimestamp();

    return i.reply({
      embeds: [embed],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  },

  // ==================================================
  // PAGAR — TRANSFERÊNCIA ENTRE MEMBROS
  // ==================================================

  async pagar(i) {
    if (!(await temCargoAutorizado(i))) {
      return responder(
        i,
        "❌ Você não possui um cargo autorizado a transferir créditos."
      );
    }

    const usuario = i.options.getUser("membro");
    const valor = i.options.getInteger("valor");
    const motivo = i.options.getString("motivo").trim();

    if (!usuario || usuario.bot || usuario.id === i.user.id) {
      return responder(
        i,
        "❌ Escolha outro membro que não seja um bot ou você mesmo."
      );
    }

    if (!Number.isInteger(valor) || valor < 1 || valor > LIMITE) {
      return responder(i, "❌ Informe um valor válido.");
    }

    if (!motivo) {
      return responder(i, "❌ Informe um motivo válido.");
    }

    const resultado = transacao(() => {
      garantirConta(i.user.id);
      garantirConta(usuario.id);

      const saldoRemetente = saldoDe(i.user.id);

      if (saldoRemetente < valor) {
        return false;
      }

      db.prepare(`
        UPDATE contas
        SET saldo = saldo - ?
        WHERE usuario_id = ?
      `).run(valor, i.user.id);

      db.prepare(`
        UPDATE contas
        SET saldo = saldo + ?
        WHERE usuario_id = ?
      `).run(valor, usuario.id);

      registrar(
        i.user.id,
        usuario.id,
        valor,
        "transferencia",
        motivo,
        i.user.id
      );

      return true;
    });

    if (!resultado) {
      return responder(i, "❌ Saldo insuficiente.");
    }

    // Registro interno enviado ao canal de auditoria.
    const registro = new EmbedBuilder()
      .setColor(0x1F4E79)
      .setTitle("🏦 REGISTRO DE TRANSFERÊNCIA FINANCEIRA")
      .setDescription(
        "Uma transferência entre membros foi concluída e registrada no sistema financeiro do Tribunal Virtual."
      )
      .addFields(
        {
          name: "📤 Remetente",
          value: `${i.user.tag}\nID: \`${i.user.id}\``,
          inline: true,
        },
        {
          name: "📥 Destinatário",
          value: `${usuario.tag}\nID: \`${usuario.id}\``,
          inline: true,
        },
        {
          name: "💰 Valor transferido",
          value: `**${formatarCreditos(valor)}**`,
          inline: false,
        },
        {
          name: "📝 Motivo",
          value: motivo.slice(0, 1024),
          inline: false,
        },
        {
          name: "🔐 Responsável pela operação",
          value: `${i.user.tag} (\`${i.user.id}\`)`,
          inline: false,
        },
        {
          name: "📋 Classificação",
          value: "Transferência entre contas",
          inline: false,
        }
      )
      .setFooter({
        text: "Banco Judicial • Registro de Auditoria",
      })
      .setTimestamp();

    await auditar({ embeds: [registro] });

    // Comprovante público da transferência.
    const embed = new EmbedBuilder()
      .setColor(0x1F4E79)
      .setTitle("🏦 BANCO JUDICIAL")
      .setDescription(
        "### ✅ Transferência realizada\n" +
        "TRIBUNAL VIRTUAL • SISTEMA FINANCEIRO\n\n" +
        "A operação foi concluída com sucesso e registrada no sistema."
      )
      .addFields(
        {
          name: "💰 VALOR TRANSFERIDO",
          value: `**＋ ${formatarCreditos(valor)}**`,
          inline: false,
        },
        {
          name: "📤 REMETENTE",
          value: `${i.user}`,
          inline: true,
        },
        {
          name: "📥 DESTINATÁRIO",
          value: `${usuario}`,
          inline: true,
        },
        {
          name: "📝 MOTIVO DA TRANSFERÊNCIA",
          value: motivo.slice(0, 1024),
          inline: false,
        }
      )
      .setFooter({
        text: "Banco Judicial • Comprovante eletrônico",
      })
      .setTimestamp();

    return i.reply({
      embeds: [embed],
      allowedMentions: { parse: [] },
    });
  },

  // ==================================================
  // CRÉDITO ADMINISTRATIVO
  // ==================================================

  async creditar(i) {
    if (!ehAdmin(i)) {
      return responder(i, "❌ Sem permissão.");
    }

    const usuario = i.options.getUser("membro");
    const valor = i.options.getInteger("valor");
    const motivo = i.options.getString("motivo").trim();

    if (!usuario || usuario.bot || !motivo) {
      return responder(
        i,
        "❌ Informe um membro válido e uma justificativa."
      );
    }

    transacao(() => {
      garantirConta(usuario.id);

      db.prepare(`
        UPDATE contas
        SET saldo = saldo + ?
        WHERE usuario_id = ?
      `).run(valor, usuario.id);

      registrar(
        null,
        usuario.id,
        valor,
        "credito_administrativo",
        motivo,
        i.user.id
      );
    });

    const registro = new EmbedBuilder()
      .setColor(0x237A57)
      .setTitle("💰 CRÉDITO ADMINISTRATIVO")
      .setDescription(
        "Um crédito administrativo foi concedido e registrado no Banco Judicial."
      )
      .addFields(
        {
          name: "👮 Administrador responsável",
          value: `${i.user.tag}\nID: \`${i.user.id}\``,
          inline: true,
        },
        {
          name: "📥 Beneficiário",
          value: `${usuario.tag}\nID: \`${usuario.id}\``,
          inline: true,
        },
        {
          name: "💰 Valor concedido",
          value: `**${formatarCreditos(valor)}**`,
          inline: false,
        },
        {
          name: "📝 Justificativa",
          value: motivo.slice(0, 1024),
          inline: false,
        }
      )
      .setFooter({
        text: "Banco Judicial • Auditoria administrativa",
      })
      .setTimestamp();

    await auditar({ embeds: [registro] });

    return responder(
      i,
      `✅ Crédito de **${formatarCreditos(valor)}** concedido a ${usuario}.`
    );
  },

  // ==================================================
  // DÉBITO ADMINISTRATIVO
  // ==================================================

  async debitar(i) {
    if (!ehAdmin(i)) {
      return responder(i, "❌ Sem permissão.");
    }

    const usuario = i.options.getUser("membro");
    const valor = i.options.getInteger("valor");
    const motivo = i.options.getString("motivo").trim();

    if (!usuario || usuario.bot || !motivo) {
      return responder(
        i,
        "❌ Informe um membro válido e uma justificativa."
      );
    }

    const debitado = transacao(() => {
      garantirConta(TESOURO);
      garantirConta(usuario.id);

      if (saldoDe(usuario.id) < valor) {
        return false;
      }

      db.prepare(`
        UPDATE contas
        SET saldo = saldo - ?
        WHERE usuario_id = ?
      `).run(valor, usuario.id);

      db.prepare(`
        UPDATE contas
        SET saldo = saldo + ?
        WHERE usuario_id = ?
      `).run(valor, TESOURO);

      registrar(
        usuario.id,
        TESOURO,
        valor,
        "debito_administrativo",
        motivo,
        i.user.id
      );

      return true;
    });

    if (!debitado) {
      return responder(
        i,
        "❌ O membro não possui saldo suficiente."
      );
    }

    const registro = new EmbedBuilder()
      .setColor(0xB22222)
      .setTitle("⚖️ REGISTRO DE DÉBITO ADMINISTRATIVO")
      .setDescription(
        "Uma retirada de créditos foi registrada no sistema financeiro do Tribunal Virtual."
      )
      .addFields(
        {
          name: "👮 Autoridade responsável",
          value: `${i.user}`,
          inline: true,
        },
        {
          name: "👤 Membro debitado",
          value: `${usuario}`,
          inline: true,
        },
        {
          name: "🏛️ Destino dos créditos",
          value: "Tesouro Judicial",
          inline: false,
        },
        {
          name: "💰 Valor retirado",
          value: `**${formatarCreditos(valor)}**`,
          inline: false,
        },
        {
          name: "📝 Justificativa",
          value: motivo.slice(0, 1024),
          inline: false,
        }
      )
      .setFooter({
        text: "Banco Judicial • Registro de Auditoria",
      })
      .setTimestamp();

    await auditar({ embeds: [registro] });

    return responder(
      i,
      `✅ Foram retirados **${formatarCreditos(valor)}** de ${usuario} e transferidos ao Tesouro Judicial.`
    );
  },

  // ==================================================
  // FINANCIAMENTO DO TESOURO
  // ==================================================

  async financiar_tesouro(i) {
    if (!ehAdmin(i)) {
      return responder(i, "❌ Sem permissão.");
    }

    const valor = i.options.getInteger("valor");
    const motivo = i.options.getString("motivo").trim();

    if (!motivo) {
      return responder(i, "❌ Informe uma justificativa.");
    }

    transacao(() => {
      garantirConta(TESOURO);

      db.prepare(`
        UPDATE contas
        SET saldo = saldo + ?
        WHERE usuario_id = ?
      `).run(valor, TESOURO);

      registrar(
        null,
        TESOURO,
        valor,
        "financiamento_tesouro",
        motivo,
        i.user.id
      );
    });

    const registro = new EmbedBuilder()
      .setColor(0x1F4E79)
      .setTitle("🏛️ FINANCIAMENTO DO TESOURO JUDICIAL")
      .addFields(
        {
          name: "👮 Responsável",
          value: `${i.user}`,
          inline: true,
        },
        {
          name: "💰 Valor adicionado",
          value: `**${formatarCreditos(valor)}**`,
          inline: true,
        },
        {
          name: "📝 Justificativa",
          value: motivo.slice(0, 1024),
          inline: false,
        }
      )
      .setTimestamp();

    await auditar({ embeds: [registro] });

    return responder(
      i,
      `🏛️ O Tesouro Judicial recebeu **${formatarCreditos(valor)}**.`
    );
  },

  // ==================================================
  // SALÁRIO
  // ==================================================

  async salario(i) {
    if (!ehAdmin(i)) {
      return responder(i, "❌ Sem permissão.");
    }

    const usuario = i.options.getUser("membro");
    const valor = i.options.getInteger("valor");
    const motivo = i.options.getString("motivo").trim();

    if (!usuario || usuario.bot || !motivo) {
      return responder(
        i,
        "❌ Informe um membro válido e uma justificativa."
      );
    }

    const pago = transacao(() => {
      garantirConta(TESOURO);
      garantirConta(usuario.id);

      if (saldoDe(TESOURO) < valor) {
        return false;
      }

      db.prepare(`
        UPDATE contas
        SET saldo = saldo - ?
        WHERE usuario_id = ?
      `).run(valor, TESOURO);

      db.prepare(`
        UPDATE contas
        SET saldo = saldo + ?
        WHERE usuario_id = ?
      `).run(valor, usuario.id);

      registrar(
        TESOURO,
        usuario.id,
        valor,
        "salario",
        motivo,
        i.user.id
      );

      return true;
    });

    if (!pago) {
      return responder(
        i,
        "❌ O Tesouro Judicial não possui créditos suficientes."
      );
    }

    const registro = new EmbedBuilder()
      .setColor(0x237A57)
      .setTitle("💼 REGISTRO DE PAGAMENTO DE SALÁRIO")
      .addFields(
        {
          name: "👮 Administrador responsável",
          value: `${i.user}`,
          inline: true,
        },
        {
          name: "👤 Funcionário",
          value: `${usuario}`,
          inline: true,
        },
        {
          name: "💰 Valor pago",
          value: `**${formatarCreditos(valor)}**`,
          inline: false,
        },
        {
          name: "📝 Descrição",
          value: motivo.slice(0, 1024),
          inline: false,
        }
      )
      .setTimestamp();

    await auditar({ embeds: [registro] });

    return responder(
      i,
      `💼 Salário de **${formatarCreditos(valor)}** pago a ${usuario}.`
    );
  },

  async multa(i) {
    return cobrar(i, "multa");
  },

  async imposto(i) {
    return cobrar(i, "imposto");
  },

  // ==================================================
  // AUDITORIA FINANCEIRA
  // ==================================================

  async auditoria(i) {
    if (!ehAdmin(i)) {
      return responder(
        i,
        "❌ Apenas administradores podem acessar a auditoria."
      );
    }

    const membro = i.options.getUser("membro");
    const tipo = i.options.getString("tipo");
    const pagina = i.options.getInteger("pagina") ?? 1;

    const filtros = [];
    const parametros = [];

    if (membro) {
      filtros.push("(origem = ? OR destino = ?)");
      parametros.push(membro.id, membro.id);
    }

    if (tipo) {
      filtros.push("tipo = ?");
      parametros.push(tipo);
    }

    const where = filtros.length
      ? `WHERE ${filtros.join(" AND ")}`
      : "";

    const total = db.prepare(`
      SELECT COUNT(*) AS quantidade
      FROM transacoes
      ${where}
    `).get(...parametros).quantidade;

    const totalPaginas = Math.max(
      1,
      Math.ceil(total / 10)
    );

    if (pagina > totalPaginas) {
      return responder(
        i,
        `❌ Página inválida. Existem ${totalPaginas} páginas.`
      );
    }

    const linhas = db.prepare(`
      SELECT *
      FROM transacoes
      ${where}
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `).all(
      ...parametros,
      10,
      (pagina - 1) * 10
    );

    const nomeConta = (id) => {
      if (!id) return "Sistema";
      if (id === TESOURO) return "Tesouro Judicial";
      return `<@${id}>`;
    };

    const registros = linhas.map((t) => {
      const data = formatarData(t.data);

      return [
        `**#${t.id} — ${t.tipo.replace(/_/g, " ").toUpperCase()}**`,
        `💰 **Valor:** ${formatarCreditos(t.valor)}`,
        `📤 **Origem:** ${nomeConta(t.origem)}`,
        `📥 **Destino:** ${nomeConta(t.destino)}`,
        `👮 **Responsável:** ${nomeConta(t.operador)}`,
        `📝 **Motivo:** ${(t.motivo || "Não informado").slice(0, 120)}`,
        `🕒 ${data}`,
      ].join("\n");
    });

    const descricao = [
      `**Registros encontrados:** ${total}`,
      `**Filtro de membro:** ${membro ? membro.tag : "Todos"}`,
      `**Tipo:** ${tipo ? tipo.replace(/_/g, " ") : "Todos"}`,
      "",
      `## 📑 Movimentações — Página ${pagina}/${totalPaginas}`,
      "",
      registros.length
        ? registros.join("\n\n━━━━━━━━━━━━━━\n\n")
        : "Nenhuma movimentação encontrada.",
    ].join("\n");

    const embed = new EmbedBuilder()
      .setColor(0x1F4E79)
      .setAuthor({
        name: "TRIBUNAL VIRTUAL • BANCO JUDICIAL",
      })
      .setTitle("📋 AUDITORIA FINANCEIRA")
      .setDescription(descricao.slice(0, 4096))
      .setFooter({
        text: "Banco Judicial • Acesso administrativo",
      })
      .setTimestamp();

    return i.reply({
      embeds: [embed],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  },
  
  async aviso(i) {
    if (!ehAdmin(i)) {
      return responder(i, "❌ Apenas administradores podem publicar avisos.");
    }

    const canal = i.options.getChannel("canal");
    const titulo = i.options.getString("titulo").trim();
    const mensagem = i.options.getString("mensagem").trim();

    if (!canal || !canal.isTextBased() || !canal.send) {
      return responder(i, "❌ Selecione um canal de texto válido.");
    }

    if (!titulo || !mensagem) {
      return responder(i, "❌ Preencha o título e a mensagem.");
    }

    const embed = new EmbedBuilder()
      .setColor(0x1F4E79)
      .setAuthor({
        name: "TRIBUNAL VIRTUAL • COMUNICADO OFICIAL",
      })
      .setTitle(`📢 ${titulo}`)
      .setDescription(mensagem)
      .addFields({
        name: "🏛️ Instituição",
        value: "Tribunal Virtual",
        inline: true,
      })
      .setFooter({
        text: `Publicado por ${i.user.tag}`,
      })
      .setTimestamp();

    try {
      await canal.send({
        embeds: [embed],
        allowedMentions: { parse: [] },
      });

      
      await auditar({
        embeds: [
          new EmbedBuilder()
            .setColor(0x1F4E79)
            .setTitle("📋 Registro de Publicação de Aviso")
            .setDescription(
              "Um comunicado oficial foi publicado pelo sistema."
            )
            .addFields(
              {
                name: "👤 Responsável",
                value: `${i.user} (\`${i.user.tag}\`)`,
                inline: true,
              },
              {
                name: "🆔 ID do responsável",
                value: `\`${i.user.id}\``,
                inline: true,
              },
              {
                name: "📢 Canal de destino",
                value: `${canal}`,
                inline: true,
              },
              {
                name: "📝 Título do aviso",
                value: titulo,
                inline: false,
              },
              {
                name: "📄 Conteúdo publicado",
                value:
                  mensagem.length > 1000
                    ? `${mensagem.slice(0, 1000)}...`
                    : mensagem,
                inline: false,
              }
            )
            .setFooter({
              text: "Tribunal Virtual • Sistema de Auditoria",
            })
            .setTimestamp(),
        ],
      });


      return responder(
        i,
        `✅ Aviso publicado com sucesso em ${canal}.`
      );
    } catch (erro) {
      console.error("Erro ao publicar aviso:", erro);

      return responder(
        i,
        "❌ Não consegui publicar o aviso. Verifique as permissões do bot no canal."
      );
    }
  },
};

// ==================================================
// MULTAS E IMPOSTOS
// ==================================================

async function cobrar(i, tipo) {
  if (!ehAdmin(i)) {
    return responder(i, "❌ Sem permissão.");
  }

  const usuario = i.options.getUser("membro");
  const valor = i.options.getInteger("valor");
  const motivo = i.options.getString("motivo").trim();

  if (!usuario || usuario.bot || !motivo) {
    return responder(
      i,
      "❌ Informe um membro válido e uma justificativa."
    );
  }

  const cobrado = transacao(() => {
    garantirConta(TESOURO);
    garantirConta(usuario.id);

    if (saldoDe(usuario.id) < valor) {
      return false;
    }

    db.prepare(`
      UPDATE contas
      SET saldo = saldo - ?
      WHERE usuario_id = ?
    `).run(valor, usuario.id);

    db.prepare(`
      UPDATE contas
      SET saldo = saldo + ?
      WHERE usuario_id = ?
    `).run(valor, TESOURO);

    registrar(
      usuario.id,
      TESOURO,
      valor,
      tipo,
      motivo,
      i.user.id
    );

    return true;
  });

  if (!cobrado) {
    return responder(
      i,
      "❌ O membro não possui saldo suficiente."
    );
  }

  if (tipo === "multa") {
    const registro = new EmbedBuilder()
      .setColor(0x8B1E1E)
      .setTitle("⚖️ TRIBUNAL VIRTUAL")
      .setDescription(
        "## AUTO DE INFRAÇÃO\n" +
        "Foi registrada uma penalidade financeira no sistema do Tribunal Virtual."
      )
      .addFields(
        {
          name: "📄 Natureza do registro",
          value: "Multa administrativa fictícia",
          inline: false,
        },
        {
          name: "👨‍⚖️ Autoridade responsável",
          value: `${i.user}`,
          inline: true,
        },
        {
          name: "👤 Autuado",
          value: `${usuario}`,
          inline: true,
        },
        {
          name: "💰 Valor da penalidade",
          value: `**${formatarCreditos(valor)}**`,
          inline: false,
        },
        {
          name: "📚 Fundamentação / Justificativa",
          value: motivo.slice(0, 1024),
          inline: false,
        },
        {
          name: "🏛️ Destinação dos valores",
          value: "Tesouro Judicial",
          inline: false,
        }
      )
      .setFooter({
        text: "Banco Judicial • Documento de uso exclusivo em roleplay",
      })
      .setTimestamp();

    await auditar({ embeds: [registro] });
  } else {
    const registro = new EmbedBuilder()
      .setColor(0xB8860B)
      .setTitle("🏛️ REGISTRO DE IMPOSTO")
      .addFields(
        {
          name: "👮 Responsável",
          value: `${i.user}`,
          inline: true,
        },
        {
          name: "👤 Contribuinte",
          value: `${usuario}`,
          inline: true,
        },
        {
          name: "💰 Valor cobrado",
          value: `**${formatarCreditos(valor)}**`,
          inline: false,
        },
        {
          name: "📝 Justificativa",
          value: motivo.slice(0, 1024),
          inline: false,
        },
        {
          name: "🏛️ Destino dos valores",
          value: "Tesouro Judicial",
          inline: false,
        }
      )
      .setFooter({
        text: "Banco Judicial • Registro de Auditoria",
      })
      .setTimestamp();

    await auditar({ embeds: [registro] });
  }

  return responder(
    i,
    `✅ ${tipo === "multa" ? "Multa" : "Imposto"} de **${formatarCreditos(valor)}** aplicado a ${usuario}.`
  );
}

// ==================================================
// INICIALIZAÇÃO DO BOT
// ==================================================

client.once("ready", async () => {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);

    await guild.commands.set(comandos);

    console.log(
      `Banco Judicial online como ${client.user.tag}`
    );
    console.log(
      `Comandos registrados no servidor ${guild.name}`
    );
  } catch (erro) {
    console.error(
      "Erro ao registrar os comandos:",
      erro
    );
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const handler = handlers[interaction.commandName];
  if (!handler) return;

  try {
    await handler(interaction);
  } catch (erro) {
    console.error(
      `Erro no comando ${interaction.commandName}:`,
      erro
    );

    try {
      await responder(
        interaction,
        "❌ Ocorreu um erro ao executar o comando. Tente novamente."
      );
    } catch (erroResposta) {
      console.error(
        "Não foi possível responder à interação:",
        erroResposta
      );
    }
  }
});

client.login(TOKEN);