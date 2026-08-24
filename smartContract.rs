use anchor_lang::prelude::*;
use mpl_bubblegum::instructions::TransferCpiBuilder;

declare_id!("3dhSvYubK3XUhE5QdfYTgxJnc3rCdyU5Nt1TcjeC6K6a");

#[program]
pub mod certchain {
    use super::*;

    pub fn inicializar_registro(
        ctx: Context<InicializarRegistro>,
        tasa_plataforma_bps: u16,
    ) -> Result<()> {
        require!(tasa_plataforma_bps <= 10_000, ErrorCodigo::TasaInvalida);

        let registro = &mut ctx.accounts.registro_global;
        registro.admin = ctx.accounts.admin.key();
        registro.tasa_plataforma_bps = tasa_plataforma_bps;
        registro.total_emisores = 0;
        registro.total_certificados = 0;
        registro.activo = true;
        registro.bump = ctx.bumps.registro_global;
        Ok(())
    }

    pub fn establecer_estado_registro(ctx: Context<AdminRegistro>, activo: bool) -> Result<()> {
        ctx.accounts.registro_global.activo = activo;
        Ok(())
    }

    pub fn registrar_emisor(
        ctx: Context<RegistrarEmisor>,
        nombre: String,
        uri_metadata: String,
    ) -> Result<()> {
        require!(nombre.len() <= 64, ErrorCodigo::TextoDemasiadoLargo);
        require!(uri_metadata.len() <= 128, ErrorCodigo::TextoDemasiadoLargo);

        let emisor = &mut ctx.accounts.emisor;
        let registro = &mut ctx.accounts.registro_global;

        emisor.autoridad = ctx.accounts.autoridad.key();
        emisor.nombre = nombre;
        emisor.uri_metadata = uri_metadata;
        emisor.autorizado = true;
        emisor.total_emitidos = 0;
        emisor.bump = ctx.bumps.emisor;

        registro.total_emisores = registro
            .total_emisores
            .checked_add(1)
            .ok_or(ErrorCodigo::Overflow)?;
        Ok(())
    }

    pub fn emitir_certificado(
        ctx: Context<EmitirCertificado>,
        asset_id: Pubkey,
        uri: String,
    ) -> Result<()> {
        require!(
            ctx.accounts.registro_global.activo,
            ErrorCodigo::RegistroInactivo
        );
        require!(ctx.accounts.emisor.autorizado, ErrorCodigo::NoAutorizado);
        require!(uri.len() <= 128, ErrorCodigo::TextoDemasiadoLargo);

        let cert = &mut ctx.accounts.certificado;
        let emisor = &mut ctx.accounts.emisor;
        let registro = &mut ctx.accounts.registro_global;

        cert.asset_id = asset_id;
        cert.emisor = emisor.key();
        cert.propietario = ctx.accounts.receptor.key();
        cert.uri = uri;
        cert.estado = EstadoCert::Activo;
        cert.precio_sol = 0;
        cert.en_venta = false;
        cert.bump = ctx.bumps.certificado;

        emisor.total_emitidos = emisor
            .total_emitidos
            .checked_add(1)
            .ok_or(ErrorCodigo::Overflow)?;
        registro.total_certificados = registro
            .total_certificados
            .checked_add(1)
            .ok_or(ErrorCodigo::Overflow)?;

        Ok(())
    }

    pub fn transferir_gratuito<'info>(
        ctx: Context<'_, '_, '_, 'info, TransferirGratuito<'info>>,
        root: [u8; 32],
        data_hash: [u8; 32],
        creator_hash: [u8; 32],
        nonce: u64,
        index: u32,
    ) -> Result<()> {
        let cert = &mut ctx.accounts.certificado;
        require!(
            cert.estado == EstadoCert::Activo,
            ErrorCodigo::CertificadoInactivo
        );
        require!(!cert.en_venta, ErrorCodigo::CertificadoEnVenta);

        let remaining_accounts: Vec<(&AccountInfo, bool, bool)> = ctx
            .remaining_accounts
            .iter()
            .map(|acc| (acc, false, false))
            .collect();

        TransferCpiBuilder::new(&ctx.accounts.bubblegum_program.to_account_info())
            .tree_config(&ctx.accounts.tree_config.to_account_info())
            .merkle_tree(&ctx.accounts.merkle_tree.to_account_info())
            .leaf_owner(&ctx.accounts.propietario.to_account_info(), true)
            .leaf_delegate(&ctx.accounts.propietario.to_account_info(), false)
            .new_leaf_owner(&ctx.accounts.nuevo_propietario.to_account_info())
            .log_wrapper(&ctx.accounts.log_wrapper.to_account_info())
            .compression_program(&ctx.accounts.compression_program.to_account_info())
            .system_program(&ctx.accounts.system_program.to_account_info())
            .add_remaining_accounts(&remaining_accounts)
            .root(root)
            .data_hash(data_hash)
            .creator_hash(creator_hash)
            .nonce(nonce)
            .index(index)
            .invoke()?;

        cert.propietario = ctx.accounts.nuevo_propietario.key();

        Ok(())
    }

    pub fn poner_en_venta(ctx: Context<PonerEnVenta>, precio_sol: u64) -> Result<()> {
        let cert = &mut ctx.accounts.certificado;
        require!(
            cert.estado == EstadoCert::Activo,
            ErrorCodigo::CertificadoInactivo
        );
        require!(precio_sol > 0, ErrorCodigo::PrecioInvalido);

        cert.precio_sol = precio_sol;
        cert.en_venta = true;

        Ok(())
    }

    pub fn cancelar_venta(ctx: Context<CancelarVenta>) -> Result<()> {
        let cert = &mut ctx.accounts.certificado;
        require!(cert.en_venta, ErrorCodigo::NoEnVenta);

        cert.en_venta = false;
        cert.precio_sol = 0;

        Ok(())
    }

    pub fn comprar_directo<'info>(
        ctx: Context<'_, '_, '_, 'info, ComprarDirecto<'info>>,
        root: [u8; 32],
        data_hash: [u8; 32],
        creator_hash: [u8; 32],
        nonce: u64,
        index: u32,
    ) -> Result<()> {
        let cert = &mut ctx.accounts.certificado;
        require!(cert.en_venta, ErrorCodigo::NoEnVenta);
        require!(
            cert.estado == EstadoCert::Activo,
            ErrorCodigo::CertificadoInactivo
        );

        let precio = cert.precio_sol;
        let bps = ctx.accounts.registro_global.tasa_plataforma_bps as u64;

        // Comisión de la plataforma
        let comision = precio
            .checked_mul(bps)
            .ok_or(ErrorCodigo::Overflow)?
            .checked_div(10_000)
            .ok_or(ErrorCodigo::Overflow)?;
        let monto_vendedor = precio.checked_sub(comision).ok_or(ErrorCodigo::Overflow)?;

        // Pago al vendedor
        anchor_lang::solana_program::program::invoke(
            &anchor_lang::solana_program::system_instruction::transfer(
                &ctx.accounts.comprador.key(),
                &ctx.accounts.vendedor.key(),
                monto_vendedor,
            ),
            &[
                ctx.accounts.comprador.to_account_info(),
                ctx.accounts.vendedor.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        // Comisión al admin de la plataforma
        if comision > 0 {
            anchor_lang::solana_program::program::invoke(
                &anchor_lang::solana_program::system_instruction::transfer(
                    &ctx.accounts.comprador.key(),
                    &ctx.accounts.admin.key(),
                    comision,
                ),
                &[
                    ctx.accounts.comprador.to_account_info(),
                    ctx.accounts.admin.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }

        // Transferencia del cNFT vía Bubblegum CPI
        let remaining_accounts: Vec<(&AccountInfo, bool, bool)> = ctx
            .remaining_accounts
            .iter()
            .map(|acc| (acc, false, false))
            .collect();

        TransferCpiBuilder::new(&ctx.accounts.bubblegum_program.to_account_info())
            .tree_config(&ctx.accounts.tree_config.to_account_info())
            .merkle_tree(&ctx.accounts.merkle_tree.to_account_info())
            .leaf_owner(&ctx.accounts.vendedor.to_account_info(), false)
            .leaf_delegate(&ctx.accounts.vendedor.to_account_info(), false)
            .new_leaf_owner(&ctx.accounts.comprador.to_account_info())
            .log_wrapper(&ctx.accounts.log_wrapper.to_account_info())
            .compression_program(&ctx.accounts.compression_program.to_account_info())
            .system_program(&ctx.accounts.system_program.to_account_info())
            .add_remaining_accounts(&remaining_accounts)
            .root(root)
            .data_hash(data_hash)
            .creator_hash(creator_hash)
            .nonce(nonce)
            .index(index)
            .invoke()?;

        cert.propietario = ctx.accounts.comprador.key();
        cert.en_venta = false;
        cert.precio_sol = 0;

        Ok(())
    }

    pub fn reportar_robo(ctx: Context<ReportarRobo>) -> Result<()> {
        let cert = &mut ctx.accounts.certificado;
        require!(
            cert.estado != EstadoCert::Revocado,
            ErrorCodigo::CertificadoRevocado
        );

        if cert.estado == EstadoCert::Activo {
            cert.estado = EstadoCert::Inactivo;
        } else if cert.estado == EstadoCert::Inactivo {
            cert.estado = EstadoCert::Activo;
        }

        Ok(())
    }

    pub fn revocar_certificado(ctx: Context<RevocarCertificado>) -> Result<()> {
        let cert = &mut ctx.accounts.certificado;
        cert.estado = EstadoCert::Revocado;
        cert.en_venta = false;
        cert.precio_sol = 0;
        Ok(())
    }

    pub fn actualizar_uri(ctx: Context<ActualizarUri>, nueva_uri: String) -> Result<()> {
        require!(nueva_uri.len() <= 128, ErrorCodigo::TextoDemasiadoLargo);
        let cert = &mut ctx.accounts.certificado;
        cert.uri = nueva_uri;
        Ok(())
    }
}

// --- STRUCTS DE CUENTAS ---

#[derive(Accounts)]
pub struct InicializarRegistro<'info> {
    #[account(
        init,
        payer = admin,
        space = RegistroGlobal::SPACE,
        seeds = [b"registro_global"],
        bump
    )]
    pub registro_global: Account<'info, RegistroGlobal>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminRegistro<'info> {
    #[account(
        mut,
        seeds = [b"registro_global"],
        bump = registro_global.bump,
        has_one = admin @ ErrorCodigo::NoAutorizado
    )]
    pub registro_global: Account<'info, RegistroGlobal>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct RegistrarEmisor<'info> {
    #[account(
        mut,
        seeds = [b"registro_global"],
        bump = registro_global.bump,
        has_one = admin @ ErrorCodigo::NoAutorizado
    )]
    pub registro_global: Account<'info, RegistroGlobal>,
    #[account(
        init,
        payer = admin,
        space = Emisor::SPACE,
        seeds = [b"emisor", autoridad.key().as_ref()],
        bump
    )]
    pub emisor: Account<'info, Emisor>,
    /// CHECK: solo se usa como referencia de clave pública para el PDA del emisor
    pub autoridad: AccountInfo<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(asset_id: Pubkey)]
pub struct EmitirCertificado<'info> {
    #[account(
        mut,
        seeds = [b"emisor", autoridad.key().as_ref()],
        bump = emisor.bump,
        has_one = autoridad @ ErrorCodigo::NoAutorizado
    )]
    pub emisor: Account<'info, Emisor>,
    #[account(
        mut,
        seeds = [b"registro_global"],
        bump = registro_global.bump
    )]
    pub registro_global: Account<'info, RegistroGlobal>,
    #[account(
        init,
        payer = autoridad,
        space = Certificado::SPACE,
        seeds = [b"certificado", asset_id.as_ref()],
        bump
    )]
    pub certificado: Account<'info, Certificado>,
    /// CHECK: cuenta del receptor inicial del cNFT
    pub receptor: AccountInfo<'info>,
    #[account(mut)]
    pub autoridad: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferirGratuito<'info> {
    #[account(
        mut,
        seeds = [b"certificado", certificado.asset_id.as_ref()],
        bump = certificado.bump,
        has_one = propietario @ ErrorCodigo::NoEsPropietario
    )]
    pub certificado: Account<'info, Certificado>,
    #[account(mut)]
    pub propietario: Signer<'info>,
    pub nuevo_propietario: AccountInfo<'info>,
    pub tree_config: AccountInfo<'info>,
    #[account(mut)]
    pub merkle_tree: AccountInfo<'info>,
    pub log_wrapper: AccountInfo<'info>,
    pub compression_program: AccountInfo<'info>,
    pub bubblegum_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PonerEnVenta<'info> {
    #[account(
        mut,
        seeds = [b"certificado", certificado.asset_id.as_ref()],
        bump = certificado.bump,
        has_one = propietario @ ErrorCodigo::NoEsPropietario
    )]
    pub certificado: Account<'info, Certificado>,
    pub propietario: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelarVenta<'info> {
    #[account(
        mut,
        seeds = [b"certificado", certificado.asset_id.as_ref()],
        bump = certificado.bump,
        has_one = propietario @ ErrorCodigo::NoEsPropietario
    )]
    pub certificado: Account<'info, Certificado>,
    pub propietario: Signer<'info>,
}

#[derive(Accounts)]
pub struct ComprarDirecto<'info> {
    #[account(
        mut,
        seeds = [b"certificado", certificado.asset_id.as_ref()],
        bump = certificado.bump,
        constraint = certificado.propietario == vendedor.key() @ ErrorCodigo::PropietarioInvalido
    )]
    pub certificado: Account<'info, Certificado>,
    #[account(
        seeds = [b"registro_global"],
        bump = registro_global.bump
    )]
    pub registro_global: Account<'info, RegistroGlobal>,
    #[account(mut)]
    pub comprador: Signer<'info>,
    #[account(mut)]
    pub vendedor: AccountInfo<'info>,
    #[account(
        mut,
        constraint = admin.key() == registro_global.admin @ ErrorCodigo::NoAutorizado
    )]
    pub admin: AccountInfo<'info>,
    pub tree_config: AccountInfo<'info>,
    #[account(mut)]
    pub merkle_tree: AccountInfo<'info>,
    pub log_wrapper: AccountInfo<'info>,
    pub compression_program: AccountInfo<'info>,
    pub bubblegum_program: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReportarRobo<'info> {
    #[account(
        mut,
        seeds = [b"certificado", certificado.asset_id.as_ref()],
        bump = certificado.bump,
        has_one = propietario @ ErrorCodigo::NoEsPropietario
    )]
    pub certificado: Account<'info, Certificado>,
    pub propietario: Signer<'info>,
}

#[derive(Accounts)]
pub struct RevocarCertificado<'info> {
    #[account(
        mut,
        seeds = [b"certificado", certificado.asset_id.as_ref()],
        bump = certificado.bump,
        has_one = emisor @ ErrorCodigo::NoAutorizado
    )]
    pub certificado: Account<'info, Certificado>,
    #[account(
        has_one = autoridad @ ErrorCodigo::NoAutorizado
    )]
    pub emisor: Account<'info, Emisor>,
    pub autoridad: Signer<'info>,
}

#[derive(Accounts)]
pub struct ActualizarUri<'info> {
    #[account(
        mut,
        seeds = [b"certificado", certificado.asset_id.as_ref()],
        bump = certificado.bump,
        has_one = emisor @ ErrorCodigo::NoAutorizado
    )]
    pub certificado: Account<'info, Certificado>,
    #[account(
        has_one = autoridad @ ErrorCodigo::NoAutorizado
    )]
    pub emisor: Account<'info, Emisor>,
    pub autoridad: Signer<'info>,
}

// --- ESTADOS Y ESTRUCTURAS DE DATOS ---

#[account]
pub struct RegistroGlobal {
    pub admin: Pubkey,
    pub tasa_plataforma_bps: u16,
    pub total_emisores: u32,
    pub total_certificados: u64,
    pub activo: bool,
    pub bump: u8,
}

impl RegistroGlobal {
    pub const SPACE: usize = 8 + 32 + 2 + 4 + 8 + 1 + 1;
}

#[account]
pub struct Emisor {
    pub autoridad: Pubkey,
    pub nombre: String,
    pub uri_metadata: String,
    pub autorizado: bool,
    pub total_emitidos: u64,
    pub bump: u8,
}

impl Emisor {
    pub const SPACE: usize = 8 + 32 + (4 + 64) + (4 + 128) + 1 + 8 + 1;
}

#[account]
pub struct Certificado {
    pub asset_id: Pubkey,
    pub emisor: Pubkey,
    pub propietario: Pubkey,
    pub uri: String,
    pub estado: EstadoCert,
    pub precio_sol: u64,
    pub en_venta: bool,
    pub bump: u8,
}

impl Certificado {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + (4 + 128) + 1 + 8 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum EstadoCert {
    Activo,
    Inactivo,
    Revocado,
}

// --- ERRORES ---

#[error_code]
pub enum ErrorCodigo {
    #[msg("No estás autorizado para realizar esta acción.")]
    NoAutorizado,
    #[msg("No eres el propietario de este certificado.")]
    NoEsPropietario,
    #[msg("El certificado está inactivo o suspendido.")]
    CertificadoInactivo,
    #[msg("El certificado ha sido revocado permanentemente.")]
    CertificadoRevocado,
    #[msg("El certificado ya se encuentra en venta.")]
    CertificadoEnVenta,
    #[msg("El certificado no está en venta.")]
    NoEnVenta,
    #[msg("El precio ingresado es inválido.")]
    PrecioInvalido,
    #[msg("El propietario indicado no coincide.")]
    PropietarioInvalido,
    #[msg("El registro global está inactivo.")]
    RegistroInactivo,
    #[msg("La tasa de plataforma debe estar entre 0 y 10000 bps.")]
    TasaInvalida,
    #[msg("El texto proporcionado excede la longitud máxima permitida.")]
    TextoDemasiadoLargo,
    #[msg("Ocurrió un desbordamiento aritmético.")]
    Overflow,
}
