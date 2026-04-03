// =============================================
// CONTROLADOR DE AUTENTICACIÓN - TECHSTORE PRO
// =============================================
const admin = require('../config/FirebaseAdmin');
const User = require('../models/User');
const logger = require('../config/logger');
const AppError = require('../config/AppError');
const crypto = require('crypto');
const { MailerSend, EmailParams, Sender, Recipient } = require("mailersend");
console.log('🔐 Inicializando controlador de autenticación');
const {
  savePendingVerification,
  getPendingVerification,
  deletePendingVerification
} = require('../utils/pendingVerifications');
// =============================================
// FUNCIÓN 1: REGISTER - REGISTRO DIRECTO (PARA GOOGLE)
// =============================================

/**
 * @desc    Registrar nuevo usuario directo en MongoDB (para Google/OAuth)
 * @route   POST /api/auth/register
 * @access  Público
 */
const register = async (req, res) => {
  const { firstName, lastName, email, password, phone, role, provider } = req.body;

  console.log(`📝 Registro directo para: ${email} (Provider: ${provider || 'local'})`);

  // VALIDACIÓN 1: Verificar campos requeridos
  if (!firstName || !lastName || !email) {
    throw new AppError('firstName, lastName y email son obligatorios', 400);
  }

  // VALIDACIÓN 2: Verificar que el email NO esté registrado
  const existingUser = await User.findOne({ email: email.toLowerCase() });
  if (existingUser) {
    console.log(`❌ Email ya registrado: ${email}`);
    throw new AppError('Ya existe una cuenta con este email', 400);
  }

  // VALIDACIÓN 3: Contraseña o proveedor
  let finalPassword = password;
  if (!password && provider === 'google') {
    finalPassword = 'GoogleTemp123';
    console.log('🟢 Registro con Google: contraseña temporal aplicada');
  }

  if (!finalPassword) {
    throw new AppError('Debes proporcionar una contraseña o usar proveedor OAuth', 400);
  }

  // ✅ CREAR USUARIO DIRECTAMENTE EN MONGODB
  const user = new User({
    firstName,
    lastName,
    email: email.toLowerCase(),
    password: finalPassword,
    phone,
    role: role || 'customer',
    provider: provider || 'local',
    isEmailVerified: provider === 'google',
    isActive: true
  });

  await user.save();
  console.log(`💾 Usuario guardado en MongoDB: ${email}`);

  logger.audit('USER_REGISTERED', {
    userId: user._id,
    email: user.email,
    role: user.role,
    provider: provider || 'local',
    ip: req.ip,
    userAgent: req.get('user-agent')
  });

  const token = user.generateAuthToken();
  const publicProfile = user.getPublicProfile();

  const userResponse = {
    ...publicProfile,
    fitnessProfile: user.fitnessProfile || {
      questionnaireCompleted: false
    }
  };

  console.log(`🎫 Token generado para: ${user.email}`);
  console.log(`🏋️ Cuestionario completado: ${user.fitnessProfile?.questionnaireCompleted || false}`);

  res.status(201).json({
    success: true,
    message: 'Registro exitoso',
    data: {
      token,
      user: userResponse
    }
  });
};

// =============================================
// NUEVA FUNCIÓN: REGISTER WITH CODE - REGISTRO CON CÓDIGO
// =============================================

/**
 * @desc    Registro con código de verificación (NO guarda en MongoDB hasta verificar)
 * @route   POST /api/auth/register-with-code
 * @access  Público
 */
const registerWithCode = async (req, res) => {
  const { firstName, lastName, email, password, phone, role } = req.body;

  console.log(`📝 Registro con código para: ${email}`);

  // VALIDACIÓN 1: Verificar campos requeridos
  if (!firstName || !lastName || !email || !password) {
    console.log('❌ Faltan campos requeridos');
    throw new AppError('firstName, lastName, email y password son obligatorios', 400);
  }

  // VALIDACIÓN 2: Verificar que el email NO esté registrado
  const existingUser = await User.findOne({ email: email.toLowerCase() });
  if (existingUser) {
    console.log(`❌ Email ya registrado: ${email}`);
    throw new AppError('Ya existe una cuenta con este email', 400);
  }

  // GENERAR CÓDIGO DE 6 DÍGITOS
  const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
  console.log(`🔢 Código generado: ${verificationCode}`);

  // ✨ GUARDAR DATOS TEMPORALMENTE (NO EN MONGODB)
  const userData = {
    firstName,
    lastName,
    email: email.toLowerCase(),
    password, // Se encriptará cuando se guarde en MongoDB
    phone,
    role: role || 'customer',
    provider: 'local'
  };

  await savePendingVerification(email, verificationCode, userData);

  // ENVIAR EMAIL CON CÓDIGO
  try {
    await sendVerificationCodeEmail(email, firstName, verificationCode);
    console.log(`📧 Código enviado a: ${email}`);
  } catch (err) {
    console.error(`❌ Error enviando email: ${err.message}`);
    // Limpiar verificación si falla el email
    await deletePendingVerification(email);
    throw new AppError('No se pudo enviar el código de verificación', 500);
  }

  // ✅ RESPUESTA EXITOSA (USUARIO AÚN NO ESTÁ EN BD)
  res.status(200).json({
    success: true,
    message: 'Código de verificación enviado a tu correo',
    email: email.toLowerCase()
  });
};

// =============================================
// FUNCIÓN 2: LOGIN - AUTENTICAR USUARIO
// =============================================

/**
 * @desc    Login de usuario
 * @route   POST /api/auth/login
 * @access  Público
 */
const login = async (req, res) => {
  const { email, password } = req.body;

  console.log(`🔐 Intento de login: ${email}`);

  // VALIDACIÓN 1: Verificar campos requeridos
  if (!email || !password) {
    throw new AppError('Email y contraseña son requeridos', 400);
  }

  // BUSCAR USUARIO (incluye contraseña para verificar)
  const user = await User.findByCredentials(email);

  if (!user) {
    logger.warn('Login failed - User not found', { email, ip: req.ip });
    throw new AppError('Email o contraseña incorrectos', 404);
  }

  // VERIFICAR SI LA CUENTA ESTÁ ACTIVA
  if (!user.isActive) {
    console.log(`❌ Cuenta inactiva: ${email}`);
    throw new AppError('Tu cuenta ha sido desactivada. Contacta soporte.', 401);
  }

  // VERIFICAR SI LA CUENTA ESTÁ BLOQUEADA
  if (user.isLocked) {
    console.log(`🔒 Cuenta bloqueada: ${email}`);
    throw new AppError('Demasiados intentos fallidos. Intenta en 30 minutos.', 401);
  }

  // COMPARAR CONTRASEÑA
  const isPasswordCorrect = await user.comparePassword(password);

  if (!isPasswordCorrect) {
    logger.warn('Login failed - Invalid password', {
      email,
      ip: req.ip
    });

    // Incrementar intentos fallidos
    await user.incrementLoginAttempts();

    throw new AppError('Email o contraseña incorrectos', 401);
  }

  // LOGIN EXITOSO
  logger.audit('USER_LOGIN', {
    userId: user._id,
    email: user.email,
    ip: req.ip,
    userAgent: req.get('user-agent')
  });

  logger.info('Login exitoso', { email: user.email });

  // Resetear intentos fallidos
  await user.resetLoginAttempts();

  // GENERAR TOKEN JWT
  const token = user.generateAuthToken();

  // OBTENER PERFIL PÚBLICO
  const publicProfile = user.getPublicProfile();

  const userResponse = {
    ...publicProfile,
    role: user.role,
    fitnessProfile: user.fitnessProfile || { questionnaireCompleted: false }
  };

  console.log(`🎫 Token generado para: ${user.email}`);

  // RESPUESTA EXITOSA
  res.status(200).json({
    success: true,
    message: 'Login exitoso',
    data: {
      token,
      user: userResponse
    }
  });
};

// =============================================
// FUNCIÓN 3: GET PROFILE - OBTENER PERFIL
// =============================================

/**
 * @desc    Obtener perfil del usuario autenticado
 * @route   GET /api/auth/profile
 * @access  Privado (requiere token)
 */
const getProfile = async (req, res) => {
  // req.user será agregado por middleware de autenticación (Parte 3C3)
  // Por ahora usamos ID de query params para testing
  const userId = req.query.userId || req.user?.id;

  if (!userId) {
    throw new AppError('ID de usuario requerido', 400);
  }

  console.log(`👤 Obteniendo perfil: ${userId}`);

  // BUSCAR USUARIO
  const user = await User.findById(userId)
    .populate('wishlist', 'name price mainImage')  // Incluir productos de wishlist
    .select('-password');  // Excluir contraseña

  if (!user) {
    console.log(`❌ Usuario no encontrado: ${userId}`);
    throw new AppError('Usuario no encontrado', 404);
  }

  // OBTENER PERFIL PÚBLICO
  const publicProfile = user.getPublicProfile();

  console.log(`✅ Perfil obtenido: ${user.email}`);

  // RESPUESTA EXITOSA
  res.status(200).json({
    success: true,
    user: publicProfile
  });
};

// =============================================
// FUNCIÓN 4: UPDATE PROFILE - ACTUALIZAR PERFIL
// =============================================

/**
 * @desc    Actualizar perfil del usuario
 * @route   PUT /api/auth/profile
 * @access  Privado (requiere token)
 */
const updateProfile = async (req, res) => {
  // Por ahora usamos userId de query params para testing
  const userId = req.query.userId || req.user?.id;

  if (!userId) {
    throw new AppError('ID de usuario requerido', 400);
  }

  console.log(`✏️ Actualizando perfil: ${userId}`);

  // CAMPOS PERMITIDOS PARA ACTUALIZAR
  const allowedUpdates = [
    'firstName',
    'lastName',
    'phone',
    'dateOfBirth',
    'gender',
    'avatar',
    'address'
  ];

  // FILTRAR SOLO CAMPOS PERMITIDOS
  const updates = {};
  Object.keys(req.body).forEach(key => {
    if (allowedUpdates.includes(key)) {
      updates[key] = req.body[key];
    }
  });

  // VALIDAR QUE HAY ALGO QUE ACTUALIZAR
  if (Object.keys(updates).length === 0) {
    throw new AppError('No hay campos para actualizar', 400);
  }

  // ACTUALIZAR USUARIO
  const user = await User.findByIdAndUpdate(
    userId,
    updates,
    {
      new: true,           // Retornar documento actualizado
      runValidators: true  // Ejecutar validaciones
    }
  );

  if (!user) {
    throw new AppError('Usuario no encontrado', 404);
  }

  console.log(`✅ Perfil actualizado: ${user.email}`);

  // OBTENER PERFIL PÚBLICO ACTUALIZADO
  const publicProfile = user.getPublicProfile();

  // RESPUESTA EXITOSA
  res.status(200).json({
    success: true,
    message: 'Perfil actualizado exitosamente',
    user: publicProfile
  });
};

// =============================================
// EXPORTAR FUNCIONES
// =============================================

// =============================================
// LOGIN CON GOOGLE (SOLO LOGIN - NO REGISTRA)
// =============================================
/**
 * @desc    Login con Google - SOLO para usuarios ya registrados
 * @route   POST /api/auth/google
 * @access  Público
 */
const googleLogin = async (req, res) => {
  const { firstName, lastName, email, uid } = req.body;

  if (!email || !uid) {
    throw new AppError('El email y UID son obligatorios', 400);
  }

  console.log(`🔍 Login con Google para: ${email}`);

  // ✅ BUSCAR USUARIO EN MONGODB PRIMERO
  let user = await User.findOne({ email: email.toLowerCase() });

  // ❌ SI NO EXISTE EN MONGODB, RECHAZAR LOGIN
  if (!user) {
    console.log(`❌ Usuario NO registrado en MongoDB: ${email}`);
    throw new AppError('Este correo no está registrado. Por favor regístrate primero.', 404);
  }

  console.log(`✅ Usuario encontrado en MongoDB: ${email}`);

  // Verificar si la cuenta está activa
  if (!user.isActive) {
    throw new AppError('Tu cuenta ha sido desactivada. Contacta soporte.', 401);
  }

  logger.audit('USER_LOGIN_GOOGLE', {
    userId: user._id,
    email: user.email,
    ip: req.ip
  });

  // 🎫 GENERAR TOKEN JWT
  const token = user.generateAuthToken();

  // 📦 OBTENER PERFIL PÚBLICO
  const publicProfile = user.getPublicProfile();

  // ⭐ AGREGAR FITNESS PROFILE
  const userResponse = {
    ...publicProfile,
    fitnessProfile: user.fitnessProfile || {
      questionnaireCompleted: false
    }
  };

  console.log(`✅ Login con Google exitoso: ${email}`);

  // ✅ DEVOLVER TOKEN Y USUARIO
  res.status(200).json({
    success: true,
    message: "Inicio de sesión con Google exitoso",
    token: token,
    user: userResponse
  });
};
// =============================================
// REGISTRO CON GOOGLE (SOLO REGISTRO - CREA USUARIO)
// =============================================
/**
 * @desc    Registro con Google - Crea nuevo usuario
 * @route   POST /api/auth/google-register
 * @access  Público
 */
const googleRegister = async (req, res) => {
  const { firstName, lastName, email, uid } = req.body;

  if (!email || !uid) {
    throw new AppError('El email y UID son obligatorios', 400);
  }

  console.log(`📝 Registro con Google para: ${email}`);

  // ✅ VERIFICAR QUE NO EXISTA YA EN MONGODB
  let existingUser = await User.findOne({ email: email.toLowerCase() });

  if (existingUser) {
    console.log(`❌ Usuario YA existe en MongoDB: ${email}`);
    throw new AppError('Este correo ya está registrado. Por favor inicia sesión.', 400);
  }

  // ✅ VERIFICAR EN FIREBASE QUE EL UID SEA VÁLIDO
  let firebaseUser;
  try {
    firebaseUser = await admin.auth().getUser(uid);
    console.log(`✅ Usuario verificado en Firebase: ${email}`);
  } catch (firebaseError) {
    console.error(`❌ Error Firebase: ${firebaseError.code}`);
    throw new AppError('Error al verificar con Google. Intenta de nuevo.', 400);
  }

  // ✅ CREAR NUEVO USUARIO EN MONGODB
  const user = new User({
    firstName: firstName || firebaseUser.displayName?.split(' ')[0] || 'Usuario',
    lastName: lastName || firebaseUser.displayName?.split(' ').slice(1).join(' ') || 'Google',
    email: email.toLowerCase(),
    password: 'GoogleTemp123',
    provider: 'google',
    isEmailVerified: true,
    isActive: true,
    role: 'customer'
  });

  await user.save();
  console.log(`💾 Usuario creado en MongoDB: ${email}`);

  logger.audit('USER_REGISTERED_GOOGLE', {
    userId: user._id,
    email: user.email,
    ip: req.ip
  });

  // 🎫 GENERAR TOKEN JWT
  const token = user.generateAuthToken();

  // 📦 OBTENER PERFIL PÚBLICO
  const publicProfile = user.getPublicProfile();

  // ⭐ AGREGAR FITNESS PROFILE
  const userResponse = {
    ...publicProfile,
    fitnessProfile: user.fitnessProfile || {
      questionnaireCompleted: false
    }
  };

  console.log(`✅ Registro con Google exitoso: ${email}`);

  // ✅ DEVOLVER TOKEN Y USUARIO
  res.status(201).json({
    success: true,
    message: "Registro con Google exitoso",
    token: token,
    user: userResponse
  });
};
const sendVerificationCodeEmail = async (email, firstName, code) => {
  const mailerSend = new MailerSend({ apiKey: process.env.MAILERSEND_API_KEY });
  const sender = new Sender(process.env.EMAIL_USER, "FitAiid 💪");
  const recipients = [new Recipient(email, firstName || "usuario")];

  const emailParams = new EmailParams()
    .setFrom(sender)
    .setTo(recipients)
    .setSubject("¡Listo para transformar tu cuerpo! - Código de Verificación")
    .setHtml(`
      <div style="margin: 0; padding: 40px 20px; background-color: #0b0d17; font-family: Arial, sans-serif; color: #ffffff;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #0d0d0d; background: radial-gradient(circle at top left, #2b0000 0%, #0d0d0d 70%); border: 1px solid #ff2a2a; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 30px rgba(255, 0, 0, 0.2);">
          
          <!-- Barra decorativa superior -->
          <div style="background-color: #ff3c00; background: linear-gradient(90deg, #ff0000 0%, #ff7a00 100%); height: 6px; width: 100%;"></div>
          
          <!-- Header / Logo -->
          <div style="padding: 30px 20px 10px; text-align: center;">
            <h1 style="margin: 0; color: #ff2a2a; font-size: 34px; font-family: 'Arial Black', Impact, sans-serif; font-weight: 900; letter-spacing: 4px; text-transform: uppercase; -webkit-text-stroke: 1.5px #ff2a2a;">FITAIID</h1>
          </div>

          <!-- Body -->
          <div style="padding: 20px 40px 40px; text-align: center;">
            <h2 style="margin-top: 0; color: #ffffff; font-size: 26px; font-weight: bold;">¡Listo para transformar tu cuerpo! 💪</h2>
            <p style="color: #d1d5db; font-size: 16px; line-height: 1.6; margin-bottom: 30px;">
              Hola <strong style="color: #fff;">${firstName || 'atleta'}</strong>, estás a un solo paso de arrancar tu evolución. Aquí tienes tu código de verificación:
            </p>
            
            <!-- Código destacado -->
            <div style="background-color: #111827; border: 2px dashed #ff3c00; padding: 25px; border-radius: 12px; margin: 20px auto; width: fit-content; text-align: center;">
              <p style="margin: 0 0 10px 0; color: #9ca3af; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Ingresa este código</p>
              <h1 style="margin: 0; color: #ff3c00; font-size: 46px; letter-spacing: 12px; font-weight: 900; padding-left: 12px;">
                ${code}
              </h1>
            </div>

            <p style="color: #9ca3af; font-size: 14px; margin-top: 25px;">
              Este código expira en <strong>15 minutos</strong>. Regresa a la aplicación e ingrésalo para activar tu cuenta.
            </p>
          </div>

          <!-- Footer -->
          <div style="background-color: #060810; padding: 20px; text-align: center; border-top: 1px solid rgba(255, 42, 42, 0.2);">
            <p style="margin: 0; color: #6b7280; font-size: 12px;">
              ¿No solicitaste este registro? Ignora este correo, tus datos están seguros.
            </p>
          </div>

        </div>
      </div>
    `)
    .setText(`¡Listo para transformar tu cuerpo! Hola ${firstName}, tu código de verificación es: ${code}. Expira en 15 minutos.`);

  await mailerSend.email.send(emailParams);
  console.log(`📩 Código enviado exitosamente a: ${email}`);
};


// =============================================
// RECUPERACIÓN DE CONTRASEÑA
// =============================================

/**
 * @desc    Solicitar código de recuperación
 * @route   POST /api/auth/forgot-password
 * @access  Público
 */
const forgotPassword = async (req, res) => {
  const { email } = req.body;

  if (!email) {
    throw new AppError('El email es requerido', 400);
  }

  console.log(`🔑 Solicitud de recuperación para: ${email}`);

  // ✅ BUSCAR USUARIO EN MONGODB
  const user = await User.findOne({ email: email.toLowerCase() });

  // ❌ SI NO EXISTE EN LA BASE DE DATOS
  if (!user) {
    console.log(`❌ Usuario NO encontrado en BD: ${email}`);
    throw new AppError('Este correo no está registrado. Por favor regístrate primero.', 404);
  }

  // ✅ SI EXISTE, CONTINUAR CON EL CÓDIGO
  console.log(`✅ Usuario encontrado en BD: ${email}`);

  // Generar código de 6 dígitos
  const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
  console.log(`📱 Código generado: ${resetCode}`);

  // Hashear el código antes de guardarlo
  const resetCodeHash = crypto
    .createHash('sha256')
    .update(resetCode)
    .digest('hex');

  // Guardar código hasheado y expiración (15 minutos)
  user.resetPasswordCode = resetCodeHash;
  user.resetPasswordExpire = Date.now() + 15 * 60 * 1000;
  await user.save();

  // Enviar email con MailerSend
  const mailerSendFP = new MailerSend({ apiKey: process.env.MAILERSEND_API_KEY });
  const senderFP = new Sender(process.env.EMAIL_USER, "FitAiid");
  const recipientsFP = [new Recipient(user.email, user.firstName)];
  const emailParamsFP = new EmailParams()
    .setFrom(senderFP)
    .setTo(recipientsFP)
    .setSubject("C\u00f3digo de Recuperaci\u00f3n de Contrase\u00f1a - FitAiid")
    .setHtml(`
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #333;">C\u00f3digo de Recuperaci\u00f3n de Contrase\u00f1a</h2>
        <p>Hola ${user.firstName},</p>
        <p>Has solicitado restablecer tu contrase\u00f1a. Tu c\u00f3digo de verificaci\u00f3n es:</p>
        <div style="background-color: #f4f4f4; padding: 20px; text-align: center; border-radius: 5px; margin: 20px 0;">
          <h1 style="color: #667eea; font-size: 36px; letter-spacing: 5px; margin: 0;">
            ${resetCode}
          </h1>
        </div>
        <p>Este c\u00f3digo expirará en <strong>15 minutos</strong>.</p>
        <p style="color: #999; font-size: 14px;">Si no solicitaste este cambio, ignora este correo.</p>
      </div>
    `)
    .setText(`Tu c\u00f3digo de recuperaci\u00f3n de FitAiid es: ${resetCode}. Expira en 15 minutos.`);
  await mailerSendFP.email.send(emailParamsFP);
  console.log(`\u2705 C\u00f3digo enviado a: ${email}`);

  logger.audit('PASSWORD_RESET_REQUESTED', {
    userId: user._id,
    email: user.email,
    ip: req.ip
  });

  res.status(200).json({
    success: true,
    message: 'Código enviado al correo electrónico'
  });
};

/**
 * @desc    Verificar código de recuperación
 * @route   POST /api/auth/verify-code
 * @access  Público
 */
const verifyResetCode = async (req, res) => {
  const { email, code } = req.body;

  if (!email || !code) {
    throw new AppError('Email y código son requeridos', 400);
  }

  console.log(`🔍 Verificando código para: ${email}`);

  // Hash del código recibido
  const codeHash = crypto
    .createHash('sha256')
    .update(code)
    .digest('hex');

  // Buscar usuario con código válido y no expirado
  const user = await User.findOne({
    email: email.toLowerCase(),
    resetPasswordCode: codeHash,
    resetPasswordExpire: { $gt: Date.now() }
  });

  if (!user) {
    console.log(`❌ Código inválido o expirado para: ${email}`);
    throw new AppError('Código inválido o expirado', 400);
  }

  console.log(`✅ Código verificado para: ${email}`);

  res.status(200).json({
    success: true,
    message: 'Código verificado correctamente'
  });
};

/**
 * @desc    Restablecer contraseña con código
 * @route   POST /api/auth/reset-password
 * @access  Público
 */
const resetPassword = async (req, res) => {
  const { email, code, password } = req.body;

  // Validar datos
  if (!email || !code || !password) {
    throw new AppError('Email, código y contraseña son requeridos', 400);
  }

  // Validar contraseña
  if (password.length < 8) {
    throw new AppError('La contraseña debe tener al menos 8 caracteres', 400);
  }

  console.log(`🔐 Restableciendo contraseña para: ${email}`);

  // Hash del código recibido
  const codeHash = crypto
    .createHash('sha256')
    .update(code)
    .digest('hex');

  // Buscar usuario con código válido y no expirado
  const user = await User.findOne({
    email: email.toLowerCase(),
    resetPasswordCode: codeHash,
    resetPasswordExpire: { $gt: Date.now() }
  });

  if (!user) {
    console.log(`❌ Código inválido o expirado para: ${email}`);
    throw new AppError('Código inválido o expirado', 400);
  }

  // Actualizar contraseña (el middleware de User.js la encriptará automáticamente)
  user.password = password;
  user.resetPasswordCode = undefined;
  user.resetPasswordExpire = undefined;
  await user.save();

  console.log(`✅ Contraseña actualizada para: ${email}`);

  logger.audit('PASSWORD_RESET_COMPLETED', {
    userId: user._id,
    email: user.email,
    ip: req.ip
  });

  res.status(200).json({
    success: true,
    message: 'Contraseña actualizada correctamente'
  });
};
/**
 * @desc    Verificar código y CREAR usuario en MongoDB
 * @route   POST /api/auth/verify-registration
 * @access  Público
 */
const verifyRegistrationCode = async (req, res) => {
  const { email, code } = req.body;

  if (!email || !code) {
    throw new AppError('Email y código son requeridos', 400);
  }

  console.log(`🔍 Verificando código para: ${email}`);

  // ✅ OBTENER DATOS TEMPORALES
  const verification = await getPendingVerification(email);

  if (!verification) {
    console.log(`❌ No hay verificación pendiente o expiró para: ${email}`);
    throw new AppError('Código inválido o expirado. Solicita uno nuevo.', 400);
  }

  // ✅ VERIFICAR CÓDIGO
  if (verification.code !== code) {
    console.log(`❌ Código incorrecto para: ${email}`);
    throw new AppError('Código incorrecto', 400);
  }

  console.log(`✅ Código correcto para: ${email}`);

  // ✅ AHORA SÍ CREAR USUARIO EN MONGODB
  const user = new User({
    ...verification.userData,
    isEmailVerified: true,
    isActive: true
  });

  await user.save();
  console.log(`💾 Usuario guardado en MongoDB: ${email}`);

  // ✅ ELIMINAR VERIFICACIÓN TEMPORAL
  await deletePendingVerification(email);

  // ✅ REGISTRAR AUDITORÍA
  logger.audit('USER_REGISTERED', {
    userId: user._id,
    email: user.email,
    role: user.role,
    ip: req.ip,
    userAgent: req.get('user-agent')
  });

  // ✅ GENERAR TOKEN
  const token = user.generateAuthToken();
  const publicProfile = user.getPublicProfile();

  res.status(201).json({
    success: true,
    message: '¡Registro completado exitosamente!',
    token,
    user: publicProfile
  });
};
/**
 * @desc    Reenviar código de verificación
 * @route   POST /api/auth/resend-verification
 * @access  Público
 */
const resendVerificationCode = async (req, res) => {
  const { email } = req.body;

  if (!email) {
    throw new AppError('Email es requerido', 400);
  }

  console.log(`🔄 Reenvío solicitado para: ${email}`);

  // Verificar que haya una verificación pendiente
  const verification = await getPendingVerification(email);

  if (!verification) {
    throw new AppError('No hay ningún registro pendiente para este email', 400);
  }

  // Generar NUEVO código
  const newCode = Math.floor(100000 + Math.random() * 900000).toString();

  // Actualizar código temporal
  await savePendingVerification(email, newCode, verification.userData);

  // Enviar nuevo email
  await sendVerificationCodeEmail(
    email,
    verification.userData.firstName,
    newCode
  );

  console.log(`📧 Nuevo código enviado a: ${email}`);

  res.status(200).json({
    success: true,
    message: 'Nuevo código enviado a tu correo'
  });
};


module.exports = {
  register,
  registerWithCode,
  login,
  getProfile,
  updateProfile,
  googleLogin,
  googleRegister,
  verifyRegistrationCode,
  forgotPassword,
  resendVerificationCode,
  verifyResetCode,
  resetPassword
};