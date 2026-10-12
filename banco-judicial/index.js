
require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
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

// Aceita tanto mensagens de texto quanto Embeds.
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

    const conteudo = typeof mensagem === "string"
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
  return interaction.memberPermissions?.has(
    PermissionFlagsBits.Administrator
  ) ?? false;
}

async function responder(interaction, texto) {
  if (interaction.replied || interaction.deferred) {
    return interaction.followUp({
      content: texto,
      ephemeral: true,
    });
  }

  return interaction.reply({
    content: texto,
    ephemeral: true,
  });
}

function comando(nome, descricao) {
  return new SlashCommandBuilder()
    .setName(nome)
    .setDescription(descricao);
}

const comandos = [

  comando("saldo_tesouro", "Consultar o saldo do Tesouro Judicial")
  .setDefaultMemberPermissions(
    PermissionFlagsBits.Administrator
  ),
  
  comando("saldo", "Consultar sua carteira"),

  comando("extrato", "Ver suas últimas movimentações"),

  comando("pagar", "Transferir créditos para um membro")
    .addUserOption((o) =>
      o.setName("membro")
        .setDescription("Destinatário")
        .setRequired(true)
    )
    .addIntegerOption((o) =>
      o.setName("valor")
        .setDescription("Valor em créditos")
        .setMinValue(1)
        .setMaxValue(LIMITE)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("tipo")
        .setDescription("Tipo de pagamento")
        .setRequired(true)
        .addChoices(
          { name: "Honorários", value: "honorarios" },
          {
            name: "Suborno fictício (roleplay)",
            value: "suborno_roleplay",
          },
          { name: "Outro", value: "outro" }
        )
    )
    .addStringOption((o) =>
      o.setName("motivo")
        .setDescription("Motivo do pagamento")
        .setMaxLength(150)
        .setRequired(true)
    ),

  comando("creditar", "Conceder créditos a um membro")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    )
    .addUserOption((o) =>
      o.setName("membro")
        .setDescription("Destinatário")
        .setRequired(true)
    )
    .addIntegerOption((o) =>
      o.setName("valor")
        .setDescription("Valor")
        .setMinValue(1)
        .setMaxValue(LIMITE)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("motivo")
        .setDescription("Justificativa")
        .setMaxLength(150)
        .setRequired(true)
    ),

    
  comando("debitar", "Retirar créditos de um membro e enviar ao tesouro")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    )
    .addUserOption((o) =>
      o.setName("membro")
        .setDescription("Membro que será debitado")
        .setRequired(true)
    )
    .addIntegerOption((o) =>
      o.setName("valor")
        .setDescription("Valor a retirar")
        .setMinValue(1)
        .setMaxValue(LIMITE)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("motivo")
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
      o.setName("valor")
        .setDescription("Valor")
        .setMinValue(1)
        .setMaxValue(LIMITE)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("motivo")
        .setDescription("Justificativa")
        .setMaxLength(150)
        .setRequired(true)
    ),

  comando("salario", "Pagar salário usando o tesouro")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    )
    .addUserOption((o) =>
      o.setName("membro")
        .setDescription("Funcionário")
        .setRequired(true)
    )
    .addIntegerOption((o) =>
      o.setName("valor")
        .setDescription("Salário")
        .setMinValue(1)
        .setMaxValue(LIMITE)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("motivo")
        .setDescription("Cargo e período")
        .setMaxLength(150)
        .setRequired(true)
    ),

  comando("multa", "Aplicar multa fictícia")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    )
    .addUserOption((o) =>
      o.setName("membro")
        .setDescription("Pessoa multada")
        .setRequired(true)
    )
    .addIntegerOption((o) =>
      o.setName("valor")
        .setDescription("Valor da multa")
        .setMinValue(1)
        .setMaxValue(LIMITE)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("motivo")
        .setDescription("Fundamento da multa no roleplay")
        .setMaxLength(150)
        .setRequired(true)
    ),

  comando("imposto", "Cobrar imposto fictício")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    )
    .addUserOption((o) =>
      o.setName("membro")
        .setDescription("Contribuinte")
        .setRequired(true)
    )
    .addIntegerOption((o) =>
      o.setName("valor")
        .setDescription("Valor do imposto")
        .setMinValue(1)
        .setMaxValue(LIMITE)
        .setRequired(true)
    )
    .addStringOption((o) =>
      o.setName("motivo")
        .setDescription("Motivo da cobrança")
        .setMaxLength(150)
        .setRequired(true)
    ),

  comando("auditoria", "Consultar transações recentes")
    .setDefaultMemberPermissions(
      PermissionFlagsBits.Administrator
    ),
];

const handlers = {

  async saldo_tesouro(i) {
  if (!ehAdmin(i)) {
    return responder(i, "Sem permissão.");
  }

  const saldo = transacao(() => {
    garantirConta(TESOURO);
    return saldoDe(TESOURO);
  });

  await responder(
    i,
    `🏛️ Saldo do Tesouro Judicial: **${saldo.toLocaleString("pt-BR")} créditos**.`
  );
  },

  async saldo(i) {
    const valor = transacao(() => {
      garantirConta(i.user.id);
      return saldoDe(i.user.id);
    });

    await responder(
      i,
      `💰 Seu saldo: **${valor.toLocaleString("pt-BR")} créditos**.`
    );
  },

    async extrato(i) {
    const dados = transacao(() => {
      garantirConta(i.user.id);

      const saldo = saldoDe(i.user.id);

      const linhas = db.prepare(`
        SELECT * FROM transacoes
        WHERE origem = ? OR destino = ?
        ORDER BY id DESC LIMIT 10
      `).all(i.user.id, i.user.id);

      const totais = db.prepare(`
        SELECT
          SUM(CASE WHEN destino = ? THEN valor ELSE 0 END) AS entradas,
          SUM(CASE WHEN origem = ? THEN valor ELSE 0 END) AS saidas
        FROM transacoes
        WHERE origem = ? OR destino = ?
      `).get(i.user.id, i.user.id, i.user.id, i.user.id);

      return { saldo, linhas, totais };
    });

    const formatar = (valor) =>
      `${(valor || 0).toLocaleString("pt-BR")} créditos`;

    const historico = dados.linhas.length
      ? dados.linhas.map((t) => {
          const entrada = t.destino === i.user.id;
          const sinal = entrada ? "+" : "−";
          const cor = entrada ? "📥" : "📤";
          const valor = formatar(t.valor);
          const data = new Date(t.data).toLocaleString("pt-BR", {
            timeZone: "America/Sao_Paulo",
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });

          return (
            `${cor} **#${t.id} — ${t.tipo.replace(/_/g, " ").toUpperCase()}**\n` +
            `　${sinal}${valor}\n` +
            `　📝 ${t.motivo.slice(0, 200)}\n` +
            `　📅 ${data}`
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
        `# ${formatar(dados.saldo)}`
      )
      .addFields(
        {
          name: "📥 Total de entradas",
          value: formatar(dados.totais.entradas),
          inline: true,
        },
        {
          name: "📤 Total de saídas",
          value: formatar(dados.totais.saidas),
          inline: true,
        },
        {
          name: "📚 Histórico recente",
          value: historico.slice(0, 3900),
          inline: false,
        }
      )
      .setFooter({
        text: "Documento financeiro • Banco Judicial",
      })
      .setTimestamp();

    await i.reply({
      embeds: [embed],
      ephemeral: true,
      allowedMentions: { parse: [] },
    });
  },

  async pagar(i) {
    if (!(await temCargoAutorizado(i))) {
      return responder(
        i,
        "❌ Você não possui um cargo autorizado a transferir créditos."
      );
    }

    const usuario = i.options.getUser("membro");
    const valor = i.options.getInteger("valor");
    const tipo = i.options.getString("tipo");
    const motivo = i.options.getString("motivo").trim();

    if (usuario.bot || usuario.id === i.user.id) {
      return responder(
        i,
        "❌ Escolha outro membro que não seja um bot."
      );
    }

    if (!motivo) {
      return responder(i, "Informe um motivo válido.");
    }

    const resultado = transacao(() => {
      garantirConta(i.user.id);
      garantirConta(usuario.id);

      if (saldoDe(i.user.id) < valor) return false;

      db.prepare(
        "UPDATE contas SET saldo = saldo - ? WHERE usuario_id = ?"
      ).run(valor, i.user.id);

      db.prepare(
        "UPDATE contas SET saldo = saldo + ? WHERE usuario_id = ?"
      ).run(valor, usuario.id);

      registrar(
        i.user.id,
        usuario.id,
        valor,
        tipo,
        motivo,
        i.user.id
      );

      return true;
    });

    if (!resultado) {
      return responder(i, "❌ Saldo insuficiente.");
    }

    await auditar(
      `💸 PAGAMENTO | ${i.user.tag} (${i.user.id}) → ` +
      `${usuario.tag} (${usuario.id}) | ` +
      `${valor.toLocaleString("pt-BR")} créditos | ${tipo} | ${motivo}`
    );

    await responder(
      i,
      `✅ Transferência realizada: **${valor.toLocaleString("pt-BR")} créditos** para ${usuario}.\n` +
      `Tipo: **${tipo}** | Motivo: ${motivo}`
    );
  },

  async creditar(i) {
    if (!ehAdmin(i)) {
      return responder(i, "Sem permissão.");
    }

    const usuario = i.options.getUser("membro");
    const valor = i.options.getInteger("valor");
    const motivo = i.options.getString("motivo").trim();

    if (usuario.bot || !motivo) {
      return responder(
        i,
        "Informe um membro válido e uma justificativa."
      );
    }

    transacao(() => {
      garantirConta(usuario.id);

      db.prepare(
        "UPDATE contas SET saldo = saldo + ? WHERE usuario_id = ?"
      ).run(valor, usuario.id);

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
      .setColor(0x1F4788)
      .setTitle("🏛️ REGISTRO DE CRÉDITO ADMINISTRATIVO")
      .setDescription(
        "Uma operação de crédito foi registrada no sistema financeiro do Tribunal Virtual."
      )
      .addFields(
        {
          name: "👮 Autoridade responsável",
          value: `${i.user}`,
          inline: true,
        },
        {
          name: "👤 Beneficiário",
          value: `${usuario}`,
          inline: true,
        },
        {
          name: "💰 Valor creditado",
          value: `**${valor.toLocaleString("pt-BR")} créditos**`,
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

    await responder(
      i,
      `✅ Crédito de **${valor.toLocaleString("pt-BR")} créditos** concedido a ${usuario}.`
    );
  },

  
  async debitar(i) {
    if (!ehAdmin(i)) {
      return responder(i, "Sem permissão.");
    }

    const usuario = i.options.getUser("membro");
    const valor = i.options.getInteger("valor");
    const motivo = i.options.getString("motivo").trim();

    if (usuario.bot || !motivo) {
      return responder(
        i,
        "Informe um membro válido e uma justificativa."
      );
    }

    const debitado = transacao(() => {
      garantirConta(TESOURO);
      garantirConta(usuario.id);

      if (saldoDe(usuario.id) < valor) return false;

      db.prepare(
        "UPDATE contas SET saldo = saldo - ? WHERE usuario_id = ?"
      ).run(valor, usuario.id);

      db.prepare(
        "UPDATE contas SET saldo = saldo + ? WHERE usuario_id = ?"
      ).run(valor, TESOURO);

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
          value: `**${valor.toLocaleString("pt-BR")} créditos**`,
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
      `✅ Foram retirados **${valor.toLocaleString("pt-BR")} créditos** de ${usuario} e transferidos ao Tesouro Judicial.`
    );
  },


  async financiar_tesouro(i) {
    if (!ehAdmin(i)) {
      return responder(i, "Sem permissão.");
    }

    const valor = i.options.getInteger("valor");
    const motivo = i.options.getString("motivo").trim();

    if (!motivo) {
      return responder(i, "Informe uma justificativa.");
    }

    transacao(() => {
      garantirConta(TESOURO);

      db.prepare(
        "UPDATE contas SET saldo = saldo + ? WHERE usuario_id = ?"
      ).run(valor, TESOURO);

      registrar(
        null,
        TESOURO,
        valor,
        "financiamento_tesouro",
        motivo,
        i.user.id
      );
    });

    await auditar(
      `🏛️ TESOURO FINANCIADO | Admin ${i.user.id} | ` +
      `${valor.toLocaleString("pt-BR")} créditos | ${motivo}`
    );

    await responder(
      i,
      `🏛️ Tesouro recebeu **${valor.toLocaleString("pt-BR")} créditos**.`
    );
  },

  async salario(i) {
    if (!ehAdmin(i)) {
      return responder(i, "Sem permissão.");
    }

    const usuario = i.options.getUser("membro");
    const valor = i.options.getInteger("valor");
    const motivo = i.options.getString("motivo").trim();

    if (usuario.bot || !motivo) {
      return responder(
        i,
        "Informe um membro válido e uma justificativa."
      );
    }

    const pago = transacao(() => {
      garantirConta(TESOURO);
      garantirConta(usuario.id);

      if (saldoDe(TESOURO) < valor) return false;

      db.prepare(
        "UPDATE contas SET saldo = saldo - ? WHERE usuario_id = ?"
      ).run(valor, TESOURO);

      db.prepare(
        "UPDATE contas SET saldo = saldo + ? WHERE usuario_id = ?"
      ).run(valor, usuario.id);

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
        "❌ O tesouro não possui créditos suficientes."
      );
    }

    await auditar(
      `💼 SALÁRIO | Admin ${i.user.id} | ${usuario.id} | ` +
      `${valor.toLocaleString("pt-BR")} créditos | ${motivo}`
    );

    await responder(
      i,
      `💼 Salário de **${valor.toLocaleString("pt-BR")} créditos** pago a ${usuario}.`
    );
  },

  async multa(i) {
    await cobrar(i, "multa");
  },

  async imposto(i) {
    await cobrar(i, "imposto");
  },

  async auditoria(i) {
    if (!ehAdmin(i)) {
      return responder(i, "Sem permissão.");
    }

    const linhas = db.prepare(`
      SELECT * FROM transacoes ORDER BY id DESC LIMIT 10
    `).all();

    if (!linhas.length) {
      return responder(i, "Ainda não há transações.");
    }

    const texto = linhas.map((t) =>
      `#${t.id} | ${t.tipo} | ${t.valor.toLocaleString("pt-BR")} créditos | ` +
      `${t.origem ?? "Sistema"} → ${t.destino ?? "Sistema"} | ` +
      `${t.motivo} | Operador: ${t.operador ?? "Sistema"}`
    ).join("\n");

    await responder(i, texto);
  },
};

async function cobrar(i, tipo) {
  if (!ehAdmin(i)) {
    return responder(i, "Sem permissão.");
  }

  const usuario = i.options.getUser("membro");
  const valor = i.options.getInteger("valor");
  const motivo = i.options.getString("motivo").trim();

  if (usuario.bot || !motivo) {
    return responder(
      i,
      "Informe um membro válido e uma justificativa."
    );
  }

  const cobrado = transacao(() => {
    garantirConta(TESOURO);
    garantirConta(usuario.id);

    if (saldoDe(usuario.id) < valor) return false;

    db.prepare(
      "UPDATE contas SET saldo = saldo - ? WHERE usuario_id = ?"
    ).run(valor, usuario.id);

    db.prepare(
      "UPDATE contas SET saldo = saldo + ? WHERE usuario_id = ?"
    ).run(valor, TESOURO);

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
          value: `**${valor.toLocaleString("pt-BR")} créditos**`,
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
    await auditar(
      `🏛️ ${tipo.toUpperCase()} | Admin ${i.user.id} | ` +
      `Membro ${usuario.id} | ${valor.toLocaleString("pt-BR")} créditos | ${motivo}`
    );
  }


  return responder(
    i,
    `✅ ${tipo} de **${valor.toLocaleString("pt-BR")} créditos** aplicado a ${usuario}.`
  );
}

client.once("ready", async () => {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.commands.set(comandos);

    console.log(`Banco Judicial online como ${client.user.tag}`);
    console.log(`Comandos registrados no servidor ${guild.name}`);
  } catch (erro) {
    console.error("Erro ao registrar os comandos:", erro);
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

    await responder(
      interaction,
      "Ocorreu um erro. Tente novamente."
    );
  }
});

client.login(TOKEN);
